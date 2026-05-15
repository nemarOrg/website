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
   * Highest `vN.0.0` — the most recent OpenNeuro pull. Per NEMAR policy:
   * every pull from OpenNeuro is a major version bump on the NEMAR side,
   * regardless of whether the upstream OpenNeuro change was minor or major.
   * `vN.x.y` for x>0 or y>0 are NEMAR-side modifications between pulls.
   * Tracked in nemarOrg/nemar-cli#448.
   */
  mirrorVersion: string | null;
  /** Every `vN.0.0` in the landing payload, newest-first. */
  allMirrorVersions: string[];
}

export type Provenance = NativeProvenance | DerivedProvenance;

const DERIVED_RELATIONS = new Set([
  "IsDerivedFrom",
  "IsVariantFormOf",
  "IsSupplementTo",
]);

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
 *   Whatever we find, we look for the lowest-numbered version in the
 *   landing payload and use that as the mirror version.
 */
export function detectProvenance(
  metadata: Pick<NeuroschemaDataset, "dataset_id" | "related_identifiers" | "external_links">,
  landing: LandingPayload | null,
): Provenance {
  const id = metadata.dataset_id;
  if (!id.startsWith("on")) return { kind: "native" };

  let originalDatasetId: string | null = null;
  let originalDoi: string | null = null;
  let originalUrl: string | null = null;

  for (const ri of metadata.related_identifiers ?? []) {
    if (!DERIVED_RELATIONS.has(ri.relation_type)) continue;
    const fromUrl = OPENNEURO_HOST_PATTERN.exec(ri.identifier);
    if (fromUrl) {
      originalDatasetId ??= fromUrl[1].toLowerCase();
      originalUrl ??= ri.identifier_type === "URL" ? ri.identifier : null;
    }
    const fromId = OPENNEURO_ID_PATTERN.exec(ri.identifier);
    if (fromId && ri.identifier_type === "DOI") {
      originalDoi ??= ri.identifier;
      originalDatasetId ??= fromId[1].toLowerCase();
    } else if (fromId) {
      originalDatasetId ??= fromId[1].toLowerCase();
    }
  }

  if (!originalDatasetId) {
    // Last-ditch: convert on005262 -> ds005262.
    const stripped = id.replace(/^on/, "ds");
    if (OPENNEURO_ID_PATTERN.test(stripped)) {
      originalDatasetId = stripped;
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
 * List every `vN.0.0` version in the landing payload, newest-first.
 *
 * Per NEMAR versioning policy (nemarOrg/nemar-cli#448):
 * every OpenNeuro pull bumps the major version on the NEMAR side
 * (regardless of whether the upstream OpenNeuro change was minor or major).
 * Intermediate `vN.x.y` (x>0 or y>0) versions represent NEMAR-side
 * modifications between pulls. So the set of "as-imported" mirror snapshots
 * is exactly the `vN.0.0` versions.
 */
export function listMirrorVersions(landing: LandingPayload | null): string[] {
  if (!landing) return [];
  return [...landing.versions]
    .filter((v) => /^v?\d+\.0\.0$/.test(v.version))
    .sort((a, b) => compareVersionTag(b.version, a.version))
    .map((v) => v.version);
}

/**
 * Latest mirror version (highest `vN.0.0`) — the most recent OpenNeuro pull.
 * Returns null when no `vN.0.0` exists in the landing payload, OR when there's
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
