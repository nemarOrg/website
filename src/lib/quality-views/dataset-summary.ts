/**
 * The dataset quality summary (nemar-cli ADR 0137 decision 8; website ADR 0035 decisions 4 and 7;
 * the live-views plan's W5 and C14): what the dataset page shows of `extensions.dataQuality` in
 * the dataset's `metadata.json`, drawn on the server as one element tree (`tree.ts`).
 *
 * The backend serves the summary only for a public dataset that is not a concealed deposit, not
 * withdrawn, published at least once and not tombstoned, and only for each recipe's current public
 * derivative (never a canary). The page adds its own gate on what it can see: a document that does
 * not say `anonymous: false` shows nothing, since unknown is not "not anonymous".
 *
 * Before anything is drawn, the summary is checked whole: the document's head names this dataset
 * (`documentHeadValid`), the summary meets neuroschema's `dataQuality` at `level: dataset`
 * (`datasetQualityValid`), and each entry keeps the writer's rules (`writerRuleBroken`). A summary
 * that fails any check is not drawn at all, and the page says why in one plain sentence. There is
 * no digest of the summary to recompute on the page: `metadata.json` carries none, and the
 * `record_sha256` it holds names the dataset record, which the backend checked against the
 * record's bytes when it kept the summary (nemar-cli B1); the page checks only that it is one.
 *
 * Every number printed is a stored value's text: a count, an edge, `n`, a median, an observed
 * range, a listed recording. A JSON number is printed as ECMAScript prints it (`numberText`), the
 * text the backend serves, since it reads the document as binary64 and writes it again. Nothing is
 * summed, averaged or rounded here; a histogram of bins of unequal width is drawn by density, but
 * the density is never printed.
 */

import {
  type DatasetRecipeSummary,
  type Distribution,
  type WriterRuleWord,
  datasetQualityValid,
  documentHeadValid,
  writerRuleBroken,
} from "./dataset-guards";
import { type HistogramModel, histogramOf } from "./model";
import { KindRefused, numberText } from "./read";
import { textTable } from "./render/figure";
import { histogramSvg, histogramTable } from "./render/histogram";
import { type Child, type Element, h } from "./tree";

/** Why a summary is not drawn. */
export type SummaryWord =
  | "document_invalid"
  | "document_other_dataset"
  | "summary_invalid"
  | WriterRuleWord
  | "histogram_unreadable";

const NOT_SHOWN = "The quality summary NEMAR published for this dataset is not shown:";

/** The plain sentence for each word. */
export const SUMMARY_SENTENCES: Readonly<Record<SummaryWord, string>> = {
  document_invalid: `${NOT_SHOWN} the dataset document it came in does not have the form neuroschema gives a dataset document.`,
  document_other_dataset: `${NOT_SHOWN} the dataset document it came in describes another dataset.`,
  summary_invalid: `${NOT_SHOWN} it does not have the form of neuroschema's dataQuality summary, so its numbers cannot be read with confidence.`,
  counts_unbalanced: `${NOT_SHOWN} its counts of recordings do not add up to the number discovered.`,
  listing_mismatch: `${NOT_SHOWN} the recordings it lists as not processed are not the failed and skipped recordings it counts.`,
  distribution_invalid: `${NOT_SHOWN} one of its histograms does not agree with its own counts or values.`,
  observed_range_mismatch: `${NOT_SHOWN} an observed range is not the lowest and highest value of its metric.`,
  histogram_unreadable: `${NOT_SHOWN} one of its histograms has bins too narrow to draw.`,
};

export interface MetricSummary {
  readonly name: string;
  readonly distribution: Distribution;
  readonly range: { readonly min: number | null; readonly max: number | null };
  readonly model: HistogramModel;
}
export interface RecipeSummary {
  readonly recipe: string;
  readonly entry: DatasetRecipeSummary;
  readonly metrics: readonly MetricSummary[];
}

export type QualitySummary =
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly word: SummaryWord; readonly sentence: string }
  | { readonly kind: "shown"; readonly recipes: readonly RecipeSummary[] };

const NONE: QualitySummary = { kind: "none" };
const refuse = (word: SummaryWord): QualitySummary => ({
  kind: "refused",
  word,
  sentence: SUMMARY_SENTENCES[word],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Names in UTF-16 code unit order, so the page lists recipes and metrics the same way each time. */
const sorted = (names: readonly string[]): string[] =>
  [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * What the page shows of a dataset document's quality summary: nothing (no summary, or a gate),
 * a refusal with its sentence, or the checked summary of each recipe.
 */
export function readQualitySummary(document: unknown, datasetId: string): QualitySummary {
  if (!isObject(document)) return NONE;
  // A concealed deposit, or a document that does not say it is not one, shows nothing at all.
  if (document.anonymous !== false) return NONE;
  const extensions = document.extensions;
  if (!isObject(extensions) || !Object.hasOwn(extensions, "dataQuality")) return NONE;
  if (!documentHeadValid(document) || document.doc_type !== "dataset") {
    return refuse("document_invalid");
  }
  if (document.dataset_id !== datasetId) return refuse("document_other_dataset");
  const quality = extensions.dataQuality;
  if (!datasetQualityValid(quality)) return refuse("summary_invalid");
  const recipes = (quality as { recipes: Record<string, DatasetRecipeSummary> }).recipes;
  const shown: RecipeSummary[] = [];
  for (const recipe of sorted(Object.keys(recipes))) {
    const entry = recipes[recipe];
    const broken = writerRuleBroken(entry);
    if (broken) return refuse(broken);
    const metrics: MetricSummary[] = [];
    for (const name of sorted(Object.keys(entry.distributions))) {
      const distribution = entry.distributions[name];
      let model: HistogramModel;
      try {
        model = histogramOf({ ...distribution.histogram, unit: distribution.unit });
      } catch (error) {
        if (error instanceof KindRefused) return refuse("histogram_unreadable");
        throw error;
      }
      metrics.push({ name, distribution, range: entry.observed_range[name], model });
    }
    shown.push({ recipe, entry, metrics });
  }
  return shown.length === 0 ? NONE : { kind: "shown", recipes: shown };
}

// ── Drawing ─────────────────────────────────────────────────────────────

/** A stored number's text, or "none" for a stored null. */
const stored = (value: number | null): string => (value === null ? "none" : numberText(value));
const integer = (value: number): string => String(value);

/** The text alternative of a metric's histogram: what it shows and every bar, by its stored text. */
export function metricLabel(metric: MetricSummary): string {
  const { model, distribution, name } = metric;
  const bars = model.items.map((item) => `${item.label}: ${integer(item.count)}`);
  for (const end of [model.underflow, model.overflow, model.missing]) {
    if (end) bars.push(`${end.label}: ${integer(end.count)}`);
  }
  const heights =
    model.heights === "density"
      ? " The bins differ in width, so a bar's height is its count per unit width and its area is its count."
      : "";
  return `${name}, in ${distribution.unit}: histogram of ${integer(distribution.n)} values.${heights} Bins and counts: ${bars.join("; ")}.`;
}

function metricFigure(metric: MetricSummary, id: string): Element {
  const { distribution: d, range, model, name } = metric;
  const captionId = `${id}-caption`;
  const stats: [string, string][] = [
    ["Values", integer(d.n)],
    ["Median", stored(d.median)],
    ["Observed range", `${stored(range.min)} to ${stored(range.max)}`],
  ];
  if (d.histogram.missing !== undefined) stats.push(["Missing", integer(d.histogram.missing)]);
  return h(
    "figure",
    { class: "qv-figure qs-metric", id, "aria-labelledby": captionId },
    h("figcaption", { id: captionId }, name, h("span", { class: "qv-kind" }, ` (${d.unit})`)),
    d.description ? h("p", { class: "qs-description" }, d.description) : null,
    h(
      "dl",
      { class: "qs-stats" },
      ...stats.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]),
    ),
    h(
      "div",
      {
        class: "qv-drawing",
        role: "img",
        "aria-roledescription": "histogram",
        "aria-label": metricLabel(metric),
      },
      histogramSvg(model, undefined, { storedTextOnly: true }),
    ),
    h(
      "details",
      { class: "qv-data" },
      h("summary", {}, "Data table"),
      model.heights === "density"
        ? textTable(
            `${name}: count per bin`,
            ["bin", "count"],
            [
              ...model.items.map((item) => [item.label, integer(item.count)]),
              ...[model.underflow, model.overflow, model.missing]
                .filter((end) => end !== null)
                .map((end) => [end.label, integer(end.count)]),
            ],
          )
        : histogramTable(model, `${name}: count per bin`),
    ),
  );
}

function copyWords(entry: DatasetRecipeSummary): string {
  const copy = entry.profile === "serving" ? "the serving copy (Zarr)" : "the archived copy (BIDS)";
  const version =
    entry.dataset_version === null
      ? "an unversioned copy of the dataset"
      : `dataset version ${entry.dataset_version}`;
  return `Computed on ${version}, read from ${copy}.`;
}

function notProcessed(entry: DatasetRecipeSummary, id: string): Child {
  const c = entry.counts;
  if (c.failed === 0 && c.skipped === 0) {
    return h("p", { class: "qs-note" }, "Every recording discovered was processed.");
  }
  const rows = entry.not_processed.map((r) => [r.path, r.status, r.code]);
  return h(
    "details",
    { class: "qs-not-processed", id },
    h("summary", {}, `Not processed: ${integer(c.failed)} failed, ${integer(c.skipped)} skipped`),
    rows.length > 0
      ? textTable("Recordings not processed", ["recording", "status", "code"], rows)
      : null,
    entry.not_processed_truncated > 0
      ? h("p", { class: "qs-note" }, `${integer(entry.not_processed_truncated)} more not listed.`)
      : null,
  );
}

function recipeSection(summary: RecipeSummary, id: string): Element {
  const { entry, recipe } = summary;
  const c = entry.counts;
  const headingId = `${id}-heading`;
  return h(
    "section",
    { class: "qs-recipe", "aria-labelledby": headingId },
    h(
      "h4",
      { id: headingId },
      recipe,
      h("span", { class: "qs-version" }, `, version ${entry.recipe_version}`),
    ),
    h("p", { class: "qs-note" }, copyWords(entry)),
    textTable(
      "Recordings",
      ["discovered", "succeeded", "failed", "skipped"],
      [[integer(c.total), integer(c.passed), integer(c.failed), integer(c.skipped)]],
    ),
    notProcessed(entry, `${id}-not-processed`),
    ...summary.metrics.map((metric, k) => metricFigure(metric, `${id}-m${k}`)),
  );
}

/** The summary as an element tree, or null when nothing is shown. `id` prefixes every id. */
export function summaryTree(summary: QualitySummary, id: string): Element | null {
  if (summary.kind === "none") return null;
  if (summary.kind === "refused") {
    return h(
      "div",
      { class: "qs-summary", id },
      h("p", { class: "qs-refused", role: "note", "data-word": summary.word }, summary.sentence),
    );
  }
  return h(
    "div",
    { class: "qs-summary", id },
    h(
      "p",
      { class: "qs-note" },
      "From the newest run of each NEMAR pipeline that was promoted to this page. Every number is as NEMAR recorded it.",
    ),
    ...summary.recipes.map((recipe, k) => recipeSection(recipe, `${id}-r${k}`)),
  );
}
