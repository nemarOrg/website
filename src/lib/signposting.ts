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
 * MALFORMED is treated the same way as missing, and for a harder reason than
 * tidiness. `metadata.json` is upstream free text, and the two values that
 * reach an href from it — a DOI and an author's ORCID — end up inside an HTTP
 * `Link` header that `[id].astro` sets in its frontmatter. `Headers.set`
 * throws on a control character, so one bad character there is a 500 on the
 * dataset page rather than one missing relation. An ORCID that is not an
 * ORCID is dropped (see `normalizeOrcid`), and so is any href that cannot be
 * serialized at all (see `isSerializableLink`).
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

/** A well-formed ORCID iD: four groups of four, the last character either a
 *  digit or the checksum `X`. */
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/**
 * Normalise an author's `orcid` to the bare `0000-0000-0000-0000` form, or
 * null when it is not an ORCID iD at all.
 *
 * THE STRIP HAS TO COME FIRST because both shapes are real. neuroschema
 * documents `orcid` as a URL (`https://orcid.org/0000-...`) while production
 * `metadata.json` ships the bare id, so validating before stripping would
 * reject every URL-form value and prefixing before validating would produce
 * `https://orcid.org/https://orcid.org/0000-...`.
 *
 * Validation is the point, not tidiness: the return value is interpolated
 * into a `Link` header, and `Headers.set` THROWS on a control character. The
 * header is set in `[id].astro`'s frontmatter, so one malformed upstream
 * value would take the whole dataset page to a 500 rather than costing one
 * `author` relation. Anything that does not match is dropped.
 */
export function normalizeOrcid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bare = raw.trim().replace(/^https?:\/\/orcid\.org\//i, "");
  return ORCID_RE.test(bare) ? bare : null;
}

/**
 * Characters that cannot appear in a `Link` header target. `<` and `>`
 * delimit the URI-Reference and `"` delimits a parameter value, so either one
 * inside an href silently re-parses the field; a control character makes
 * `Headers.set` throw outright.
 *
 * Written as a Unicode property escape (`\p{Cc}` is C0, DEL and C1) so this
 * source file carries no literal control characters of its own.
 */
const UNSAFE_HREF_RE = /[<>"\p{Cc}]/u;

/**
 * Whether a link is safe to serialize into a `Link` header.
 *
 * Applied in BOTH {@link buildSignposting} and {@link signpostingLinkHeader},
 * deliberately. Filtering only in the serializer would leave the header and
 * the `<link>` elements built from the same array describing different sets,
 * which is exactly the divergence this module's header promises cannot
 * happen; filtering only in the builder would leave the exported serializer
 * unsafe on any array it did not build. One predicate, so the two cannot
 * disagree about what is droppable.
 */
export function isSerializableLink(link: SignpostingLink): boolean {
  return !UNSAFE_HREF_RE.test(link.href);
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
  // Optional-chained despite the type saying `external_links` is required:
  // this module promises it never throws on sparse input, and a
  // `metadata.json` missing the whole object would otherwise take the dataset
  // page down instead of costing one relation.
  const conceptDoi =
    input.catalogRow?.concept_doi ?? input.metadata.external_links?.dataset_doi ?? null;
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

  // author: one per author carrying a WELL-FORMED ORCID, bounded (see
  // MAX_SIGNPOSTING_AUTHORS above). The cap is applied after validation so a
  // few malformed values cannot push real authors out of the list.
  const orcids = (input.metadata.authors ?? [])
    .map((a) => normalizeOrcid(a.orcid))
    .filter((orcid): orcid is string => orcid !== null)
    .slice(0, MAX_SIGNPOSTING_AUTHORS);
  for (const orcid of orcids) {
    links.push({ rel: "author", href: `https://orcid.org/${orcid}` });
  }

  // Last gate before either serialization. Every href above is either a fixed
  // literal, an env-configured base, or DOI-derived — and that last one is
  // free text from `metadata.json`, which is what makes this necessary rather
  // than paranoid.
  return links.filter(isSerializableLink);
}

/**
 * Serialize Signposting links as a single HTTP `Link` header field value
 * (RFC 8288): comma-separated `<uri>; rel="..."` entries, with `; type="..."`
 * appended where the link carries a media type.
 *
 * `rel` and `type` are this module's own fixed literals, so they need no
 * escaping. An href does NOT: the `cite-as` target is built from
 * `metadata.external_links.dataset_doi`, free text that dataset owners edit,
 * and RFC 8288 gives a `Link` target no escaping mechanism at all — a `>`
 * inside one simply ends the URI-Reference early. So an unserializable href
 * is DROPPED rather than escaped or emitted (see {@link isSerializableLink}
 * for why the same filter runs in the builder too).
 *
 * This used to claim no value could contain `>` or an unescaped `"`. That was
 * false for exactly the DOI case above, and a control character in the same
 * position is worse than a malformed header: `Headers.set` throws on it, and
 * this header is set in `[id].astro`'s frontmatter, so it would 500 the
 * dataset page.
 */
export function signpostingLinkHeader(links: SignpostingLink[]): string {
  return links
    .filter(isSerializableLink)
    .map((link) => {
      const params = [`rel="${link.rel}"`];
      if (link.type) params.push(`type="${link.type}"`);
      return `<${link.href}>; ${params.join("; ")}`;
    })
    .join(", ");
}
