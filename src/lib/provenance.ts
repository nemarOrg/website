import type { LandingPayload, NeuroschemaDataset, RelatedIdentifier } from "./neuroschema";

export interface NativeProvenance {
  kind: "native";
}

export interface DerivedProvenance {
  kind: "derived";
  originalDatasetId: string | null;
  originalDoi: string | null;
  originalUrl: string | null;
  /**
   * The newest mirror version: the most recent OpenNeuro pull. Per NEMAR policy:
   * every pull from OpenNeuro is a major version bump on the NEMAR side,
   * regardless of whether the upstream OpenNeuro change was minor or major.
   * `vN.x.y` for x>0 or y>0 are NEMAR-side modifications between pulls.
   * Tracked in nemarOrg/nemar-cli#448.
   *
   * Which versions are mirrors is the API's flag (see `listMirrorVersions`), so
   * this is null when none is flagged `true`, including when every `vN.0.0` is
   * `null` because its OpenNeuro snapshot is not known.
   */
  mirrorVersion: string | null;
  /** Every mirror version in the landing payload, newest-first. */
  allMirrorVersions: string[];
}

export type Provenance = NativeProvenance | DerivedProvenance;

const DERIVED_RELATIONS = new Set(["IsDerivedFrom", "IsVariantFormOf", "IsSupplementTo"]);

const OPENNEURO_ID_PATTERN = /\b(ds\d{4,7})\b/i;
const OPENNEURO_HOST_PATTERN = /openneuro\.org\/datasets\/(ds\d{4,7})/i;

/**
 * Determine the NEMAR/OpenNeuro provenance of a dataset.
 *
 * - `nm*` datasets are always native.
 * - `on*` datasets are derived. We try (in order):
 *     1. `related_identifiers[]` for a DERIVED_RELATIONS entry whose
 *        `identifier` contains a `ds` ID or an openneuro.org URL.
 *     2. `external_links.github_url` for a sibling-pattern hint.
 *     3. The dataset id itself stripped of the `on` prefix as a last-ditch
 *        guess (`on005262` -> `ds005262`).
 *   Whatever we find, the mirror versions come from the landing payload
 *   (`listMirrorVersions`: the versions the API flags as mirrors) and the
 *   newest of them is the mirror version.
 */
export function detectProvenance(
  metadata: Pick<NeuroschemaDataset, "dataset_id" | "related_identifiers" | "external_links">,
  landing: LandingPayload | null,
): Provenance {
  const id = metadata.dataset_id;
  if (!id.startsWith("on")) return { kind: "native" };

  // A dataset re-released on OpenNeuro under a new id keeps BOTH the old and
  // new id in related_identifiers as IsDerivedFrom (e.g. on002718 lists both
  // ds000117 and ds002718). Prefer the candidate whose extracted ds id
  // matches the canonical on->ds swap so the chip and link agree with the
  // dataset's actual source_id.
  const expectedDsId = id.replace(/^on/, "ds").toLowerCase();
  const candidates: Array<{ datasetId: string; doi: string | null; url: string | null }> = [];

  for (const ri of metadata.related_identifiers ?? []) {
    if (!DERIVED_RELATIONS.has(ri.relation_type)) continue;
    const fromUrl = OPENNEURO_HOST_PATTERN.exec(ri.identifier);
    if (fromUrl) {
      candidates.push({
        datasetId: fromUrl[1].toLowerCase(),
        doi: null,
        url: ri.identifier_type === "URL" ? ri.identifier : null,
      });
      continue;
    }
    const fromId = OPENNEURO_ID_PATTERN.exec(ri.identifier);
    if (fromId) {
      candidates.push({
        datasetId: fromId[1].toLowerCase(),
        doi: ri.identifier_type === "DOI" ? ri.identifier : null,
        url: null,
      });
    }
  }

  const picked = candidates.find((c) => c.datasetId === expectedDsId) ?? candidates[0] ?? null;

  let originalDatasetId: string | null = picked?.datasetId ?? null;
  const originalDoi: string | null = picked?.doi ?? null;
  let originalUrl: string | null = picked?.url ?? null;

  if (!originalDatasetId) {
    // Last-ditch: convert on005262 -> ds005262.
    if (OPENNEURO_ID_PATTERN.test(expectedDsId)) {
      originalDatasetId = expectedDsId;
    }
  }

  if (originalDatasetId && !originalUrl) {
    originalUrl = `https://openneuro.org/datasets/${originalDatasetId}`;
  }

  const allMirrorVersions = listMirrorVersions(landing);
  const mirrorVersion = allMirrorVersions[0] ?? null;

  return {
    kind: "derived",
    originalDatasetId,
    originalDoi,
    originalUrl,
    mirrorVersion,
    allMirrorVersions,
  };
}

/**
 * A version number that looks like an OpenNeuro pull. This is the guess the
 * page made before the API said which versions are mirrors; it survives only
 * as the fallback in `listMirrorVersions`.
 */
const GUESSED_MIRROR_VERSION = /^v?\d+\.0\.0$/;

/**
 * List the mirror versions in the landing payload, newest-first.
 *
 * Which versions are mirrors is the API's call, not the version number's
 * (nemar-cli ADR 0111, decision 5). Every `versions[]` entry carries
 * `mirror: true | false | null`, and only `true` is listed. `false` is not a
 * mirror. `null` is an N.0.0 whose OpenNeuro snapshot NEMAR does not know or
 * has not examined, so it is left out as well and never listed on the strength
 * of its number.
 *
 * TEMPORARY FALLBACK, removed by PR 8c2 of nemarOrg/nemar-cli#1914. A backend
 * older than the release that added the flag omits the key from every
 * version. While NO version carries it, this keeps the old guess, every
 * `vN.0.0` (each OpenNeuro pull is a NEMAR major bump and the `vN.x.y` between
 * are NEMAR's own corrections, nemarOrg/nemar-cli#448), so a site built with
 * this code does not lose every chip when it meets such a backend.
 *
 * The test is "does any version carry the key" on the whole payload, never per
 * version. Once the key is there, `null` or a missing key on one entry means
 * "not a mirror"; falling back to the number for that entry would bring back
 * the guess that `null` exists to stop. Delete the fallback only once the
 * production API sends the key on every version.
 */
export function listMirrorVersions(landing: LandingPayload | null): string[] {
  if (!landing) return [];
  // Parsed JSON has no `undefined`: an entry either has the key (true, false, null) or lacks it.
  const hasFlag = landing.versions.some((v) => v.mirror !== undefined);
  return [...landing.versions]
    .filter((v) => (hasFlag ? v.mirror === true : GUESSED_MIRROR_VERSION.test(v.version)))
    .sort((a, b) => compareVersionTag(b.version, a.version))
    .map((v) => v.version);
}

/**
 * Latest mirror version, the most recent OpenNeuro pull (see
 * `listMirrorVersions` for what counts as a mirror).
 * Returns null when the landing payload has no mirror version, OR when there's
 * only one version overall (mirror CTA is redundant when latest == mirror).
 */
export function pickMirrorVersion(landing: LandingPayload | null): string | null {
  if (!landing || landing.versions.length < 2) return null;
  return listMirrorVersions(landing)[0] ?? null;
}

/** Compare semver-ish version tags (`v1.2.3`); fall back to string compare. */
export function compareVersionTag(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      const da = pa[i] ?? 0;
      const db = pb[i] ?? 0;
      if (da !== db) return da - db;
    }
    return 0;
  }
  return a.localeCompare(b);
}

function parseVersion(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Among related identifiers, find the canonical original-paper DOI. Used by
 * the citation block on the detail page. Returns the first `References`
 * identifier that looks like a paper DOI (not a dataset DOI).
 */
export function findReferencePaperDoi(rids: RelatedIdentifier[]): string | null {
  for (const r of rids) {
    if (r.relation_type !== "References" || r.identifier_type !== "DOI") continue;
    if (/\bds\d{4,7}\b/i.test(r.identifier)) continue; // skip dataset DOIs
    return r.identifier;
  }
  return null;
}
