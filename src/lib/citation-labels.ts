/**
 * Labels for the citations dialog rows (ActionBar.astro). Pure; unit-tested,
 * because the dialog builds its rows in a component script where vitest
 * cannot reach them.
 */

export type CiteKind = "dataset" | "paper";

/** The pill on each citing work: what it cites, the dataset or its paper. */
export function citeKindLabel(kind: CiteKind): string {
  return kind === "dataset" ? "Cites the dataset" : "Cites the paper";
}

/**
 * The citing work's OWN citation count (not the dataset's), or null when
 * there is nothing worth showing. `fmt` is the number formatter the caller
 * already uses so the dialog stays consistent with its heading.
 */
export function citedByLabel(
  citedBy: unknown,
  fmt: (n: number) => string = (n) => n.toLocaleString("en-US"),
): string | null {
  if (typeof citedBy !== "number" || !Number.isFinite(citedBy) || citedBy <= 0) return null;
  return citedBy === 1 ? "cited once" : `cited ${fmt(citedBy)} times`;
}
