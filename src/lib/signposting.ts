/**
 * FAIR Signposting (https://signposting.org, RFC 8288 `Link` relations) for
 * the dataset detail page (nemarOrg/website#284 phase 3, issue #287).
 *
 * ONE MODEL, TWO SERIALIZATIONS — the same discipline `use-this-data.ts`
 * documents at its own top. {@link buildSignposting} builds a typed,
 * ordered list of link relations from data `src/pages/dataset/[id].astro`
 * already has in hand after its existing SSR fetch fan-out (id, metadata,
 * catalog row, selected version, data/api bases) — no new fetches happen
 * here. {@link signpostingLinkHeader} serializes that SAME array as the
 * HTTP `Link` response header field value; the array is also handed
 * straight to `Base.astro`'s existing `headLinks` prop (website#284 phase 2)
 * for the equivalent `<link>` elements. Divergence between "what the header
 * says" and "what a human sees in the page head" is impossible by
 * construction: neither serialization holds a fact the other doesn't
 * already carry (OSCAR parity — see the PR description; nothing here is
 * ever header-only, hidden, or user-agent-gated).
 *
 * NULL-SAFETY IS THE POINT of this module, exactly as jsonld.ts and
 * use-this-data.ts document at their own tops. Every relation degrades to
 * OMISSION — never an empty/undefined href — when its source value is
 * missing: no concept DOI means no `cite-as`; no selected version means no
 * `item`; a free-text (non-URI) license means no `license` relation. This
 * module is pure and total: it never throws on sparse/null-heavy input.
 *
 * GATING: none, deliberately. A private dataset already 404s upstream
 * before `src/pages/dataset/[id].astro` renders anything (both the landing
 * and metadata fetches fail), so it never reaches this builder at all — no
 * separate visibility check is needed or added here.
 */

import { ccLicenseUrl } from "./jsonld";
import type { NeuroschemaDataset } from "./neuroschema";
import type { Dataset } from "./types";

/** The slice of the api.nemar.org catalog row this builder reads. Optional —
 *  null for `ds*` ids and whenever the per-id lookup fails, same as
 *  `JsonLdCatalogRow` in jsonld.ts and `UseThisDataCatalogRow` in
 *  use-this-data.ts; the page already tolerates a null catalog row. */
export type SignpostingCatalogRow = Pick<Dataset, "concept_doi">;

export interface SignpostingInput {
  id: string;
  metadata: NeuroschemaDataset;
  catalogRow: SignpostingCatalogRow | null;
  /** Resolved by the page (latest, or the `?v=` override) — null only for an
   *  unpublished dataset, in which case `item` is omitted below. */
  selectedVersion: string | null;
  /** data.nemar.org base, env-aware (data-test on staging). Trailing slash optional. */
  dataBase: string;
  /** api.nemar.org base, env-aware. Trailing slash optional. */
  apiBase: string;
}

/**
 * One link relation. Structurally a subtype of `Base.astro`'s `headLinks`
 * prop entry (which additionally accepts `title`) — the same array literal
 * is valid for both `signpostingLinkHeader` and `headLinks` with no mapping
 * step, which is the point (one model, two renderers).
 */
export interface SignpostingLink {
  /** The Signposting/IANA link relation, e.g. "cite-as", "describedby". Also
   *  used verbatim as the literal relation "type" (the FAIR Signposting
   *  relation that names the described resource's class) — distinct from
   *  this interface's own `type` field below, which is the target's MIME
   *  media type. */
  rel: string;
  href: string;
  /** Media type of the target resource, e.g. "application/json". Omitted
   *  when the relation carries no useful media type (e.g. `item`, `type`). */
  type?: string;
}

/**
 * Bound on how many `author` relations a single dataset can contribute to
 * the `Link` header. A `Link` header is an HTTP header: edge proxies and
 * CDNs commonly cap a single header field value in the low tens of KB (e.g.
 * nginx's 8 KB `large_client_header_buffers` default), and an unbounded
 * author list on a large consortium dataset would push this one header
 * toward that ceiling on its own. Each ORCID relation serializes to about
 * 60 bytes (`<https://orcid.org/0000-0000-0000-0000>; rel="author", `), so
 * 25 caps that portion at roughly 1.5 KB — comfortably under budget even
 * alongside every other relation this module emits — while every real
 * fixture captured for this phase (nm000103's 8 ORCID-bearing authors is
 * the largest) sails under it untouched. The full author list still renders
 * on the page itself (`AuthorList.astro`, unbounded); only the head/header
 * surface is capped.
 */
export const MAX_SIGNPOSTING_AUTHORS = 25;

/** Bare "10.x/y" from a DOI in any of the shapes NEMAR stores it. Mirrors
 *  the private helper of the same name in jsonld.ts, use-this-data.ts and
 *  cite.ts — small enough that a fifth copy costs less than a shared export
 *  across four modules with slightly different call shapes (see
 *  use-this-data.ts's own note on this). */
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

function normalizedBase(base: string): string {
  return base.replace(/\/$/, "");
}

/**
 * Build the Signposting link relations for a dataset detail page. Pure and
 * total: never throws on sparse/null-heavy input.
 */
export function buildSignposting(input: SignpostingInput): SignpostingLink[] {
  const links: SignpostingLink[] = [];
  const dataBase = normalizedBase(input.dataBase);
  const apiBase = normalizedBase(input.apiBase);
  const id = encodeURIComponent(input.id);

  // cite-as: the CONCEPT DOI, not a version DOI — cite-as names the
  // persistent identifier for the resource, matching what jsonld.ts
  // publishes as `identifier` (same `concept_doi ?? external_links.dataset_doi`
  // precedence, so the two can never disagree about which DOI is "the" one).
  const conceptDoi =
    input.catalogRow?.concept_doi ?? input.metadata.external_links.dataset_doi ?? null;
  const citeAsUrl = doiUrl(conceptDoi);
  if (citeAsUrl) links.push({ rel: "cite-as", href: citeAsUrl });

  // describedby: the two machine-readable descriptions NEMAR actually
  // serves. Unconditional — both are deterministic from the id alone, and
  // the page only reaches this builder once metadata.json has already been
  // fetched successfully (see the module doc's GATING note).
  links.push({
    rel: "describedby",
    href: `${dataBase}/${id}/metadata.json`,
    type: "application/json",
  });
  links.push({
    rel: "describedby",
    href: `${apiBase}/datasets/${id}`,
    type: "application/json",
  });

  // item: the selected version's browsable root. Omitted for an unpublished
  // dataset (no selected version to point at) — same gate as
  // use-this-data.ts's location/download/assess/zarr sections.
  if (input.selectedVersion) {
    links.push({
      rel: "item",
      href: `${dataBase}/${id}/${encodeURIComponent(input.selectedVersion)}/`,
    });
  }

  // license: only when the free-text license string resolves to a real URI
  // via the shared jsonld.ts helper. A free-text license like
  // "CDLA-Permissive-2.0" is not a URI and must never be emitted as an
  // href — omit the relation instead, exactly like use-this-data.ts's
  // license section treats the same helper's undefined return.
  if (input.metadata.license) {
    const licenseUrl = ccLicenseUrl(input.metadata.license);
    if (licenseUrl) links.push({ rel: "license", href: licenseUrl });
  }

  // type: what the Signposting profile asks a landing page to declare about
  // itself (rel="type" naming the described resource's class) — always
  // present, independent of any per-dataset data.
  links.push({ rel: "type", href: "https://schema.org/Dataset" });
  links.push({ rel: "type", href: "https://schema.org/AboutPage" });

  // author: one per author carrying an ORCID, bounded (see
  // MAX_SIGNPOSTING_AUTHORS above).
  const orcids = (input.metadata.authors ?? [])
    .map((a) => a.orcid?.trim())
    .filter((orcid): orcid is string => Boolean(orcid))
    .slice(0, MAX_SIGNPOSTING_AUTHORS);
  for (const orcid of orcids) {
    links.push({ rel: "author", href: `https://orcid.org/${orcid}` });
  }

  return links;
}

/**
 * Serialize Signposting links as a single HTTP `Link` header field value
 * (RFC 8288): comma-separated `<uri>; rel="..."` entries, with `; type="..."`
 * appended where the link carries a media type. Every value here is either a
 * DOI-derived URL, an env-configured base URL, an id encoded via
 * `encodeURIComponent`, or one of this module's own fixed literal strings —
 * none can contain `>` or an unescaped `"`, so no further escaping is done.
 */
export function signpostingLinkHeader(links: SignpostingLink[]): string {
  return links
    .map((link) => {
      const params = [`rel="${link.rel}"`];
      if (link.type) params.push(`type="${link.type}"`);
      return `<${link.href}>; ${params.join("; ")}`;
    })
    .join(", ");
}
