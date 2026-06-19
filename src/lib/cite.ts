/**
 * Build APA + BibTeX citation strings for a NEMAR dataset from its metadata,
 * for the dataset-page "Cite" export (#126). Pure; unit-tested.
 */

export interface DatasetCitationInput {
  /** Full-name author strings, e.g. "Seyed Yahya Shirazi". */
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

/** "Seyed Yahya Shirazi" -> "Shirazi, S. Y."; single token stays as-is. */
function apaAuthor(full: string): string {
  const tokens = full.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return tokens[0];
  const family = tokens[tokens.length - 1];
  const initials = tokens
    .slice(0, -1)
    .map((t) => `${t[0].toUpperCase()}.`)
    .join(" ");
  return `${family}, ${initials}`;
}

function apaAuthorList(authors: string[]): string {
  const parts = authors.map(apaAuthor).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, & ${parts[parts.length - 1]}`;
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

  const bibAuthors = input.authors
    .map((a) => a.trim())
    .filter(Boolean)
    .join(" and ");
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
