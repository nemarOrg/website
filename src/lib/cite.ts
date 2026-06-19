/**
 * Build APA + BibTeX citation strings for a NEMAR dataset from its metadata,
 * for the dataset-page "Cite" export (#126). Pure; unit-tested.
 *
 * Author names arrive in several shapes and must not be reordered:
 *   - "Wakeman, DG"        family-first, comma + initials clump
 *   - "Henson, Richard N"  family-first, comma + given name
 *   - "Wakeman DG"         family-first, trailing initials clump (no comma)
 *   - "Seyed Yahya Shirazi" given-first, family is the last token
 */

export interface DatasetCitationInput {
  /** Author strings as stored in the metadata (any of the shapes above). */
  authors: string[];
  name: string;
  version: string | null;
  /** Publish date (ISO) or year; the 4-digit year is extracted. */
  date: string | null;
  /** Dataset DOI (bare "10.x/y", "doi:…", or a doi.org URL), or null. */
  doi: string | null;
  /** Dataset id, used for the BibTeX key. */
  id: string;
}

export interface DatasetCitation {
  apa: string;
  bibtex: string;
}

function yearOf(date: string | null): string {
  const m = date?.match(/\d{4}/);
  return m ? m[0] : "n.d.";
}

/** True when a token is a short all-caps clump of initials, e.g. "DG", "RN". */
function isInitialsClump(token: string): boolean {
  return /^[A-Z]{1,4}$/.test(token.replace(/\./g, ""));
}

/** True when a string carries no given-name words (only caps / dots / spaces). */
function looksLikeInitials(s: string): boolean {
  return /^[A-Z.\s]+$/.test(s.trim());
}

/** "DG" | "D.G." | "Daniel G" | "R N" -> "D. G." style initials. */
function toInitials(s: string): string {
  const parts = s.replace(/\./g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1 && /^[A-Z]{2,}$/.test(parts[0])) {
    return parts[0]
      .split("")
      .map((c) => `${c}.`)
      .join(" ");
  }
  return parts.map((p) => `${p[0].toUpperCase()}.`).join(" ");
}

/** Render one author as APA "Family, I. N." without ever reordering the family. */
function apaAuthor(full: string): string {
  const raw = full.trim();
  if (!raw) return "";

  const comma = raw.indexOf(",");
  if (comma !== -1) {
    const family = raw.slice(0, comma).trim();
    const rest = raw.slice(comma + 1).trim();
    if (!family) return rest;
    return rest ? `${family}, ${toInitials(rest)}` : family;
  }

  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return tokens[0];

  const last = tokens[tokens.length - 1];
  if (isInitialsClump(last)) {
    // "Wakeman DG" -> family is everything before the initials clump.
    return `${tokens.slice(0, -1).join(" ")}, ${toInitials(last)}`;
  }

  // "Seyed Yahya Shirazi" -> family is the last token.
  const initials = tokens
    .slice(0, -1)
    .map((t) => `${t[0].toUpperCase()}.`)
    .join(" ");
  return `${last}, ${initials}`;
}

function apaAuthorList(authors: string[]): string {
  const parts = authors.map(apaAuthor).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, & ${parts[parts.length - 1]}`;
}

/**
 * Render one author for BibTeX. Family-first initials forms are normalized to
 * "Family, I. N." so BibTeX parses them correctly; full given-name strings are
 * left intact (BibTeX handles "Given Middle Family" on its own).
 */
function bibtexAuthor(full: string): string {
  const raw = full.trim();
  if (!raw) return "";

  const comma = raw.indexOf(",");
  if (comma !== -1) {
    const family = raw.slice(0, comma).trim();
    const rest = raw.slice(comma + 1).trim();
    if (looksLikeInitials(rest)) return `${family}, ${toInitials(rest)}`;
    return raw;
  }

  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && isInitialsClump(tokens[tokens.length - 1])) {
    return `${tokens.slice(0, -1).join(" ")}, ${toInitials(tokens[tokens.length - 1])}`;
  }
  return raw;
}

function bareDoi(doi: string | null): string | null {
  if (!doi) return null;
  const stripped = doi
    .trim()
    .replace(/^https?:\/\/doi\.org\//i, "")
    .replace(/^doi:/i, "");
  return stripped || null;
}

export function datasetCitation(input: DatasetCitationInput): DatasetCitation {
  const year = yearOf(input.date);
  const name = input.name.trim();
  const versionPart = input.version ? ` (Version ${input.version})` : "";
  const bare = bareDoi(input.doi);
  const url = bare ? `https://doi.org/${bare}` : null;

  const apaAuthors = apaAuthorList(input.authors);
  const apa =
    `${apaAuthors ? `${apaAuthors} ` : ""}(${year}). ` +
    `${name}${versionPart} [Data set]. NEMAR.${url ? ` ${url}` : ""}`;

  const bibAuthors = input.authors.map(bibtexAuthor).filter(Boolean).join(" and ");
  const fields = [
    bibAuthors ? `  author = {${bibAuthors}}` : null,
    `  title = {${name}}`,
    `  year = {${year}}`,
    input.version ? `  version = {${input.version}}` : null,
    "  publisher = {NEMAR}",
    bare ? `  doi = {${bare}}` : null,
    url ? `  url = {${url}}` : null,
  ].filter((f): f is string => f !== null);
  const bibtex = `@misc{nemar_${input.id},\n${fields.join(",\n")}\n}`;

  return { apa, bibtex };
}
