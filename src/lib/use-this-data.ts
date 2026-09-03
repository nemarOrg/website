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
 * renderers still emit the same text either way. `value` should stay short
 * and precise (a command, a URL, a number) rather than a whole sentence;
 * `note` is where the explanatory prose that used to get folded into
 * `value` belongs instead, so a command stays copy-pasteable and a link
 * stays a link rather than a sentence-long anchor.
 */
export interface UseThisDataItem {
  key: string;
  label: string;
  value: string;
  href?: string;
  code?: boolean;
  /** Short explanatory prose accompanying `value`, rendered after it in
   *  both surfaces. Optional — most items have none. */
  note?: string;
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
  // Optional-chained despite the type saying both objects are required: this
  // module's header promises it never throws on sparse input, and these are
  // upstream documents, not values this repo constructs. `metadata.json` for
  // a `ds*` or freshly imported dataset has shipped without an
  // `external_links` object at all, and a missing `provenance` would take the
  // whole page down (Astro drops content whose render throws) rather than
  // costing one citation field.
  const doi = input.metadata.external_links?.dataset_doi ?? null;
  // datasetCitation is null-safe (no authors / no doi / no date all degrade
  // cleanly — see cite.test.ts), so this item is always present.
  //
  // `publishedVersion`, not `selectedVersion`: on the unpublished-with-a-
  // resolved-selectedVersion shape (see the doc comments on both input
  // fields) the mirror already says "no published version is available yet",
  // and a citation carrying "(Version v2.0.0)" in the same document
  // contradicts it. Every other version-gated section reads the same helper.
  const { apa } = datasetCitation({
    authors: authorNames,
    name: input.metadata.name,
    version: publishedVersion(input),
    date: input.metadata.provenance?.publish_date ?? null,
    doi,
    id: input.id,
  });
  items.push({ key: "license-citation", label: "Recommended citation", value: apa });

  // Collected before labelling so the numbering is decided knowing the total:
  // a lone reference reads "Reference", and two or more read "Reference 1" /
  // "Reference 2". The output used to mix the two ("Reference" then
  // "Reference 2"), which reads like a missing first item.
  const referenceUrls: string[] = [];
  for (const rid of input.metadata.related_identifiers ?? []) {
    if (rid.relation_type !== "References" || rid.identifier_type !== "DOI") continue;
    const url = doiUrl(rid.identifier);
    if (!url) continue;
    referenceUrls.push(url);
  }
  for (const [index, url] of referenceUrls.entries()) {
    items.push({
      key: `license-reference-${index + 1}`,
      label: referenceUrls.length === 1 ? "Reference" : `Reference ${index + 1}`,
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

/**
 * How to get the bytes. Every command and every default here is stated from
 * the CLI's own help text (`nemar dataset download --help`,
 * `nemar dataset get --help` in nemarOrg/nemar-cli
 * `src/commands/dataset.ts`), not from what the commands sound like they do.
 * Two of those defaults are counter-intuitive and were previously stated
 * wrongly here:
 *
 *  - `download` is NOT "everything". It skips `stimuli/` and `derivatives/`
 *    content by default because those trees can be very large; the annex
 *    pointers are still cloned, so `--stimuli` / `--derivatives` (on either
 *    command) fetch them later. `nemar dataset get` skips the same two by
 *    default, unless the path you ask for is itself under one of them.
 *  - `get` only works from INSIDE a clone -- it exits non-zero with
 *    "Not inside a git-annex dataset directory" anywhere else -- so the
 *    subset path needs the `cd` step spelled out. `clone` creates `./<id>`.
 *
 * `download` also takes the same subset filters as `get`, which makes a
 * one-step subset possible (`--subjects`, `--sessions`, `--tasks`, `--runs`,
 * `--datatypes`, `--include`, `--exclude`); that is the shortest path for
 * anyone who wants part of a dataset and is offered before the clone route.
 */
function buildDownloadSection(input: UseThisDataInput): UseThisDataSection | null {
  const publishedVersionValue = publishedVersion(input);
  if (!publishedVersionValue) return null;
  const base = normalizedBase(input.dataBase);
  const id = input.id;
  const version = encodeURIComponent(publishedVersionValue);
  const participantsUrl = `${base}/${encodeURIComponent(id)}/${version}/participants.tsv`;
  return {
    id: "download",
    heading: "How to download",
    items: [
      {
        key: "download-all",
        label: "The dataset",
        value: `nemar dataset download ${id}`,
        code: true,
        note: "Clones and fetches in one step. Content under stimuli/ and derivatives/ is skipped by default because those trees can be large; add --stimuli --derivatives for the whole thing.",
      },
      {
        key: "download-subset-one-step",
        label: "A subset, one step",
        value: `nemar dataset download ${id} --subjects sub-01,02`,
        code: true,
        note: "Also filters by --sessions, --tasks, --runs, --datatypes, --include and --exclude.",
      },
      {
        key: "download-subset-clone",
        label: "A subset, step 1",
        value: `nemar dataset clone ${id}`,
        code: true,
        note: `Clones git-annex pointers only; fetches no file content. Creates ./${id}.`,
      },
      {
        key: "download-subset-cd",
        label: "A subset, step 2",
        value: `cd ${id}`,
        code: true,
        note: "The get command below reads the clone's annex, so it only works from inside the clone.",
      },
      {
        key: "download-subset-get",
        label: "A subset, step 3",
        value: "nemar dataset get <files>",
        code: true,
        note: "Pulls the files you actually need. Skips stimuli/ and derivatives/ unless the path you ask for is under one of them.",
      },
      {
        key: "download-single-file",
        label: "One small file",
        value: participantsUrl,
        href: participantsUrl,
        note: "A direct HTTPS fetch works for any single file.",
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
 *
 * THE RECIPE MUST BE INDEX-FORMAT-AGNOSTIC. The published catalog is mixed
 * and stays mixed for as long as the engine-3 wave takes to re-convert the
 * back catalogue: nm000103 is still `format_version: 1` with no
 * `contract_base`, `data_base`, `s3_uri` or `layout` at all, while on004696
 * is `format_version: 3` and carries all four (verified against
 * zarr.nemar.org on 2026-09-03). So every step here keys only on fields that
 * exist in BOTH versions — `stores[].zarr` and `stores[].groups[].name` —
 * and the canonical object URI is derived as
 * `s3://nemar/<id>/zarr/<store.zarr>` rather than read from a v3-only field.
 * The v3 fields are named once, as an optimisation available when
 * `format_version >= 3`, never as a prerequisite.
 *
 * The steps mirror the canonical worked recipe in the docs repo
 * (`src/content/docs/platform/zarr/cost-ladder.md`, "Recipe-first guidance
 * for agents") rather than restating it from memory, so the two cannot drift.
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
      value: indexUrl,
      href: indexUrl,
      note: "The mandatory entry point. Never hardcode a bucket path.",
    },
    {
      key: "zarr-step-2",
      label: "2. Pick a store entry",
      value: "stores[].zarr, stores[].groups[].name",
      code: true,
      note: "These two fields exist in every index format version, so a recipe that keys on them works against the whole catalog while the back conversion is still in flight.",
    },
    {
      key: "zarr-step-3",
      label: "3. Build the store URI",
      value: `s3://nemar/${input.id}/zarr/{store.zarr}`,
      code: true,
      note: "Derivable from the store entry alone. An index at format_version 3 or later also publishes contract_base, data_base and s3_uri; use them when they are there, never require them.",
    },
    {
      key: "zarr-step-4",
      label: "4. Open the store anonymously",
      value: 'zarr.open_group(store=..., mode="r", zarr_format=3)',
      code: true,
      note: "Anonymous FsspecStore.from_url in region us-east-2, no credentials. zarr_format=3 is required: without it zarr-python probes for Zarr v2 sidecars, and because anonymous ListBucket is denied, S3 answers a missing key with 403 rather than 404 and the open raises.",
    },
    {
      key: "zarr-step-5",
      label: "5. Read the level-0 array",
      value: 'root[store.groups[0].name]["0"]',
      code: true,
      note: "Level 0 is the full-rate signal. Never read a view/ array for inference; those exist for display.",
    },
    {
      key: "zarr-step-6",
      label: "6. Dequantize the samples",
      value: "physical = digital * scale + offset",
      code: true,
      note: "scale and offset are attributes of the level-0 array, one entry per channel; the unit is on the group's channels attribute.",
    },
    {
      key: "zarr-step-7",
      label: "7. Slice, don't download",
      value: "signal[0:4, 0:500]",
      code: true,
      note: "Stream a window of channels and samples; download only when you will touch most of the array.",
    },
    {
      key: "zarr-step-8",
      label: "8. Know the HTTP contract",
      value: "index.json",
      code: true,
      note: "Only index.json is always proxied and edge-cached. A plain GET for a store object, manifest.json or events.parquet 302s to the public S3 object for non-browser clients, so follow redirects, and HEAD is never redirected.",
    },
    {
      key: "zarr-step-9",
      label: "9. Read the attribution before reuse",
      value: 'root.attrs["nemar"]',
      code: true,
      note: "The store carries its own dataset id, DOI, license, citation and source commit.",
    },
    {
      key: "zarr-step-10",
      label: "10. Filter for pipelines",
      value: "has_zarr=1",
      code: true,
      note: "This is the converted filter. has_zarr_verified is the stricter one, and its result set can be empty until the daily fidelity sweep reaches a dataset; verification is reported, never a precondition for serving (nemar-cli ADR 0005).",
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

// ---------------------------------------------------------------------------
// Markdown escaping
// ---------------------------------------------------------------------------
//
// THE MIRROR INTERPOLATES UPSTREAM FREE TEXT INTO MARKUP, so it needs the same
// discipline `jsonld.ts` gets from `JSON.stringify` and `sitemap.ts` gets from
// `escapeXml`. A dataset name, a license string, an author name and a DOI all
// come from `metadata.json`, which is edited by dataset owners rather than
// generated by this repo; dropped straight into `# <name>`,
// `**<label>:** <value>` or `[<value>](<href>)` they can end the block they
// were meant to sit inside and start new markdown structure below it. A
// newline is the cheapest version (it ends the heading or the list item
// outright), `](` in a DOI is the sharpest (it closes our link and opens the
// author's), and a stray backtick pairs with the next one in the document.
//
// Exported because `use-this-data.test.ts` renders the same transform to
// assert model→markdown parity, and asserting it against a private copy of
// these rules is how the two would drift.

/** Whitespace (newlines included) plus every Unicode control character
 *  (`\p{Cc}`, which is C0, DEL and C1). Written as a property escape rather
 *  than a `\u0000-\u001f` range so the source carries no literal control
 *  characters of its own. */
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]+/gu;

/**
 * Collapse every whitespace or control-character run to a single space and
 * trim. Run first by all three helpers below: a model value is a single line
 * of display text by contract, and every markdown structure this renderer
 * emits (heading, list item, link) is terminated by a newline, so collapsing
 * is what makes the escaping below sufficient rather than merely helpful.
 */
export function collapseForMarkdown(value: string): string {
  return value.replace(WHITESPACE_OR_CONTROL, " ").trim();
}

/**
 * Escape a string for use as markdown TEXT — a label, a plain value, a note,
 * or the text half of a link.
 *
 * Escapes the backslash first (otherwise it would escape our own escapes),
 * then the characters that can change the structure around it: `[` and `]`
 * (which is what neutralises a `](` breakout inside link text) and the
 * backtick (which would otherwise open a code span). A leading `#`, `-`, `+`
 * or `>` is escaped too, so a value that reaches the start of a line cannot
 * begin a heading, a list item or a block quote. Emphasis markers are
 * deliberately left alone: `*` and `_` cannot break out of the enclosing
 * construct, and escaping them would put visible backslashes into ordinary
 * dataset names.
 */
export function escapeMarkdownText(value: string): string {
  return collapseForMarkdown(value)
    .replace(/[\\`[\]]/g, (c) => `\\${c}`)
    .replace(/^[#\-+>]/, (c) => `\\${c}`);
}

/**
 * Wrap a value in a code span. Backslash escapes do not apply inside a code
 * span, so the fence has to grow instead: it is always one backtick longer
 * than the longest backtick run in the value, and a value that starts or ends
 * with a backtick is padded with a space (CommonMark strips one leading and
 * trailing space when both are present, so the padding does not show).
 */
export function markdownCodeSpan(value: string): string {
  const text = collapseForMarkdown(value);
  const longestRun = [...text.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Make a link destination safe to place inside `(...)`. Percent-encodes the
 * characters that would terminate the destination early or be read as
 * markup — parentheses, angle brackets, a double quote, a backslash, and any
 * space left after collapsing. Percent-encoding rather than an autolink
 * because these are real URLs: `%28` is what the target server would receive
 * for a literal parenthesis anyway, so the link stays clickable and correct.
 */
export function safeMarkdownUrl(href: string): string {
  return collapseForMarkdown(href).replace(
    /[()<>"\\ ]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * Absolute URL of a dataset page's markdown mirror, for the
 * `rel="alternate"` link the page advertises.
 *
 * THE TRAILING SLASH HAS TO GO FIRST. `astro.config.mjs` sets
 * `trailingSlash: "ignore"`, so `/dataset/nm000103` and
 * `/dataset/nm000103/` are both live URLs for the same page, and the second
 * one is what a crawler following a slash-terminated link arrives on.
 * Appending `.md` to that pathname produced `/dataset/nm000103/.md`, which
 * matches no route in `src/pages/` and 404s — an advertised alternate that
 * only works on one of the two spellings of the page advertising it.
 *
 * `origin` comes from the caller's `canonicalOriginFor` so the mirror URL and
 * the page's own canonical URL cannot name different hosts.
 */
export function markdownMirrorUrl(pathname: string, origin: string): string {
  return new URL(`${pathname.replace(/\/+$/, "")}.md`, origin).toString();
}

/**
 * Render the model as markdown — the `.md` mirror's entire body. Every fact
 * the model carries appears here (the load-bearing parity guarantee tested in
 * use-this-data.test.ts, checked through `escapeMarkdownText` since that is
 * the form a fact takes on this surface); the HTML component renders the
 * identical `sections`/`items` structure, so the two surfaces cannot drift.
 *
 * Every interpolated value goes through one of the three escapers above. The
 * only unescaped strings below are this function's own literals.
 */
export function renderUseThisDataMarkdown(model: UseThisData): string {
  const title = `${escapeMarkdownText(model.name)} (${escapeMarkdownText(model.datasetId)})`;
  // Same wording as the HTML disclosure's summary (UseThisData.astro), so the
  // page and the mirror name this material identically.
  const lines: string[] = [`# ${title}`, "", "## How to use the data (for agentic research)", ""];

  if (model.unpublished) {
    lines.push("This dataset has been registered but no published version is available yet.", "");
  }

  for (const section of model.sections) {
    lines.push(`### ${escapeMarkdownText(section.heading)}`, "");
    for (const paragraph of section.intro ?? []) {
      lines.push(escapeMarkdownText(paragraph), "");
    }
    for (const item of section.items) {
      const rendered = item.href
        ? `[${escapeMarkdownText(item.value)}](${safeMarkdownUrl(item.href)})`
        : item.code
          ? markdownCodeSpan(item.value)
          : escapeMarkdownText(item.value);
      // A period, not an em dash, separates value from note (repo writing
      // style avoids em dashes) -- only added when there's a note to say.
      const noteSuffix = item.note ? `. ${escapeMarkdownText(item.note)}` : "";
      lines.push(`- **${escapeMarkdownText(item.label)}:** ${rendered}${noteSuffix}`);
    }
    lines.push("");
  }

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
