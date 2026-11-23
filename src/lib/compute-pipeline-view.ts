/**
 * Pure view models for the admin Pipelines tab (nemar-cli ADR 0134 decision 5; epic
 * nemarOrg/nemar-cli#2324 phase 4b, website#586). No fetch, no clock, no DOM: the pages call these
 * and print what they return as text nodes.
 *
 * WORDS. A status, mark or outcome this build knows gets its tone, icon and the CLI's code; a word
 * the open contract grows gets a neutral tone, a neutral icon and the raw word, escaped, so the page
 * never draws an unknown state as a known good one.
 *
 * INERT TEXT. Every backend string passes through `displaySafeLine` before it is shown and none is
 * put in an href: a recording path is text derived from a dataset.
 */

import type { BadgeTone } from "./admin-badges";
import type { KpiSpec } from "./admin-overview";
import { COMPUTE_EXECUTORS } from "./compute-admin-contract";
import type {
  PipelineCell,
  PipelineCoverage,
  PipelineCoverageCard,
  PipelineGridQuery,
  PipelineGridRow,
  PipelineTrendPoint,
} from "./compute-pipeline-api";
import {
  COMPUTE_DATASET_ID_RE,
  COMPUTE_PIPELINE_GRID_PAGE_MAX,
  COMPUTE_PIPELINE_GRID_STATUSES,
  COMPUTE_PIPELINE_RECIPE_VERSION_RE,
  COMPUTE_PIPELINE_STAMP_ID_RE,
  COMPUTE_PIPELINE_TREND_DAYS_MAX,
  PIPELINE_RECIPE_SEGMENT_RE,
  RUNNER_ID_RE,
  STANDARD_CHECKPOINTS,
} from "./compute-pipeline-contract";
import {
  PIPELINE_LABELS,
  PIPELINE_MARK_WORDS,
  completeLine,
  summaryText,
} from "./compute-pipeline-labels";
import { displaySafeLine } from "./mail-display";
import type { IconName } from "./status-icons";

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** A word for a person: the backend's word with `_` read as a space, escaped. */
export function wordText(word: string): string {
  return displaySafeLine(word.trim() || "unknown").replaceAll("_", " ");
}

export interface Pill {
  readonly label: string;
  readonly tone: BadgeTone;
  readonly icon: IconName;
  /** The word is one this build draws; otherwise the label is the raw word. */
  readonly known: boolean;
}

const STATUS_STYLE: Readonly<Record<string, { tone: BadgeTone; icon: IconName }>> = {
  not_started: { tone: "neutral", icon: "neutral" },
  waiting: { tone: "neutral", icon: "progress" },
  running: { tone: "info", icon: "progress" },
  stalled: { tone: "warning", icon: "warn" },
  finished: { tone: "success", icon: "ok" },
  failed: { tone: "danger", icon: "error" },
};

/** The pill for a row's status. */
export function statusPill(word: string): Pill {
  const known = (COMPUTE_PIPELINE_GRID_STATUSES as readonly string[]).includes(word);
  const style = known ? STATUS_STYLE[word] : { tone: "neutral" as const, icon: "neutral" as const };
  return { label: wordText(word), tone: style.tone, icon: style.icon, known };
}

/** Each mark's CLI code, tone, icon and spoken words (`failed` adds its count: `F<n>`). */
const MARK_STYLE: Readonly<
  Record<string, { code: string; tone: BadgeTone; icon: IconName; spoken: string }>
> = {
  passed: { code: "", tone: "success", icon: "ok", spoken: PIPELINE_MARK_WORDS.passed },
  failed: { code: "F", tone: "danger", icon: "error", spoken: PIPELINE_MARK_WORDS.failed },
  skipped: { code: "x", tone: "neutral", icon: "neutral", spoken: PIPELINE_MARK_WORDS.skipped },
  running: { code: "R", tone: "info", icon: "progress", spoken: PIPELINE_MARK_WORDS.running },
  stalled: { code: "S", tone: "warning", icon: "warn", spoken: PIPELINE_MARK_WORDS.stalled },
  waiting: { code: "W", tone: "neutral", icon: "progress", spoken: PIPELINE_MARK_WORDS.waiting },
  pending: { code: "P", tone: "neutral", icon: "progress", spoken: PIPELINE_MARK_WORDS.pending },
  no_counts: { code: "?", tone: "neutral", icon: "neutral", spoken: PIPELINE_MARK_WORDS.no_counts },
  not_started: {
    code: "-",
    tone: "neutral",
    icon: "neutral",
    spoken: PIPELINE_MARK_WORDS.not_started,
  },
};

export interface CellView {
  /** `passed/total`, or empty when the cell has no counts. */
  readonly counts: string;
  /** The CLI's code: `F3`, `x`, `R`, `S`, `W`, `P`, `?`, `-`, nothing for passed, or the raw word. */
  readonly code: string;
  readonly tone: BadgeTone;
  readonly icon: IconName;
  /** The full phrase a screen reader says for the cell. */
  readonly spoken: string;
  readonly known: boolean;
}

/** One grid cell as the page draws it; an unreadable cell is `?`, labelled unreadable. */
export function cellView(cell: PipelineCell | null): CellView {
  if (cell === null) {
    return {
      counts: "",
      code: "?",
      tone: "neutral",
      icon: "neutral",
      spoken: PIPELINE_LABELS.unreadable,
      known: false,
    };
  }
  const known = Object.hasOwn(MARK_STYLE, cell.mark);
  const c = cell.counts;
  const counts = c ? `${c.passed}/${c.total}` : "";
  const countWords = c ? `${c.passed} of ${c.total} passed` : "";
  if (!known) {
    const raw = wordText(cell.mark);
    return {
      counts,
      code: raw,
      tone: "neutral",
      icon: "neutral",
      spoken: countWords ? `${countWords}, ${raw}` : raw,
      known: false,
    };
  }
  const style = MARK_STYLE[cell.mark];
  const failed = c?.failed ?? 0;
  const code = cell.mark === "failed" ? `F${failed}` : style.code;
  let spoken: string;
  if (cell.mark === "failed") {
    spoken = `${countWords ? `${countWords}, ` : ""}${failed} failed`;
  } else if (cell.mark === "passed") {
    spoken = countWords || style.spoken;
  } else {
    spoken = countWords ? `${countWords}, ${style.spoken}` : style.spoken;
  }
  return { counts, code, tone: style.tone, icon: style.icon, spoken, known: true };
}

/** An outcome word, raw as the CLI prints it, or `none`. */
export function outcomeText(word: string | null): string {
  return word === null ? PIPELINE_LABELS.none : displaySafeLine(word);
}

/** A D1 time as served, with its zone said; never parsed (it would read as local time). */
export function d1Time(value: string | null): string {
  return value === null ? PIPELINE_LABELS.none : `${displaySafeLine(value)} UTC`;
}

/** The anchor of a checkpoint's section on the run page; only a standard checkpoint gets one. */
export function checkpointAnchor(word: string): string | null {
  return (STANDARD_CHECKPOINTS as readonly string[]).includes(word) ? `cp-${word}` : null;
}

/** The executor column: a runner's name, else the executor word, else a dash. */
export function executorText(row: PipelineGridRow): string {
  const run = row.run;
  if (!run) return "-";
  return displaySafeLine(run.runner_name ?? run.executor ?? "-");
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export const PIPELINES_PATH = "/admin/pipelines";

/** The grid page of a recipe; the recipe is checked first so a malformed one never reaches a link. */
export function gridHref(recipe: string, params: Record<string, string | undefined> = {}): string {
  const base = `${PIPELINES_PATH}/${PIPELINE_RECIPE_SEGMENT_RE.test(recipe) ? recipe : ""}`;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/** The run page of a stamp, at one checkpoint's section when it has an anchor. */
export function runHref(stampId: number, checkpoint?: string): string {
  const anchor = checkpoint ? checkpointAnchor(checkpoint) : null;
  return `${PIPELINES_PATH}/runs/${stampId}${anchor ? `#${anchor}` : ""}`;
}

/** A cell links to the run's section when the row has a run and the cell has something to show. */
export function cellHref(row: PipelineGridRow, checkpoint: string): string | null {
  const cell = row.cells[checkpoint];
  if (!row.run || !cell) return null;
  const c = cell.counts;
  const hasFailures = cell.listed > 0 || (c !== null && c.failed + c.skipped > 0);
  return hasFailures ? runHref(row.run.stamp_id, checkpoint) : null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The recipe segment of a grid path, or null when it is not a recipe name. */
export function parseRecipeParam(raw: string | undefined): string | null {
  return raw !== undefined && PIPELINE_RECIPE_SEGMENT_RE.test(raw) ? raw : null;
}

/** A stamp id from a path: the pattern and a safe integer, or null (one 404 for every bad id). */
export function parseStampParam(raw: string | undefined): number | null {
  if (raw === undefined || !COMPUTE_PIPELINE_STAMP_ID_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** `?days=` for the landing page: 1 to the maximum, else ignored. */
export function parseDaysParam(raw: string | null): number | undefined {
  if (raw === null || !/^[0-9]{1,3}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= COMPUTE_PIPELINE_TREND_DAYS_MAX ? n : undefined;
}

export interface ParsedGridQuery {
  readonly query: PipelineGridQuery;
  /** The filters the page dropped, by name, so it can say so. */
  readonly ignored: readonly string[];
  /** The runner was dropped because a runner's jobs are not Tapis jobs. */
  readonly runnerWithTapis: boolean;
}

/** The grid's filters from the page's URL: each checked against its pattern or word list. */
export function parseGridQuery(recipe: string, params: URLSearchParams): ParsedGridQuery {
  const ignored: string[] = [];
  const pick = (name: string, ok: (v: string) => boolean): string | undefined => {
    const v = params.get(name);
    if (v === null || v === "") return undefined;
    if (ok(v)) return v;
    ignored.push(name);
    return undefined;
  };
  const status = pick("status", (v) =>
    (COMPUTE_PIPELINE_GRID_STATUSES as readonly string[]).includes(v),
  );
  const recipeVersion = pick("recipe_version", (v) => COMPUTE_PIPELINE_RECIPE_VERSION_RE.test(v));
  const executor = pick("executor", (v) => (COMPUTE_EXECUTORS as readonly string[]).includes(v));
  let runner = pick("runner", (v) => RUNNER_ID_RE.test(v));
  const dataset = pick("dataset", (v) => COMPUTE_DATASET_ID_RE.test(v));
  const after = pick("after", (v) => COMPUTE_DATASET_ID_RE.test(v));
  const limitRaw = pick("limit", (v) => {
    if (!/^[0-9]{1,3}$/.test(v)) return false;
    const n = Number(v);
    return n >= 1 && n <= COMPUTE_PIPELINE_GRID_PAGE_MAX;
  });
  let runnerWithTapis = false;
  if (runner !== undefined && executor === "tapis") {
    runner = undefined;
    runnerWithTapis = true;
    ignored.push("runner");
  }
  return {
    query: {
      recipe,
      status,
      recipe_version: recipeVersion,
      executor,
      runner,
      dataset,
      after,
      limit: limitRaw === undefined ? undefined : Number(limitRaw),
    },
    ignored,
    runnerWithTapis,
  };
}

/** The filters of a grid query, as URL parameters (no `after`). */
export function filterParams(q: PipelineGridQuery): Record<string, string | undefined> {
  return {
    status: q.status,
    recipe_version: q.recipe_version,
    executor: q.executor,
    runner: q.runner,
    dataset: q.dataset,
    limit: q.limit === undefined ? undefined : String(q.limit),
  };
}

/** Whether any filter narrows the grid (paging aside). */
export function isFiltered(q: PipelineGridQuery): boolean {
  return [q.status, q.recipe_version, q.executor, q.runner, q.dataset].some((v) => v !== undefined);
}

export interface PipelinePager {
  readonly next: string | null;
  readonly first: string | null;
}

/** Next and first page links, keeping the filters. */
export function pipelinePager(
  recipe: string,
  q: PipelineGridQuery,
  nextAfter: string | null,
): PipelinePager {
  const params = filterParams(q);
  return {
    next: nextAfter === null ? null : gridHref(recipe, { ...params, after: nextAfter }),
    first: q.after === undefined ? null : gridHref(recipe, params),
  };
}

// ---------------------------------------------------------------------------
// Coverage cards
// ---------------------------------------------------------------------------

/** Failed and ended runs over a trend. */
export function trendSums(trend: readonly PipelineTrendPoint[]): { failed: number; ended: number } {
  let failed = 0;
  let ended = 0;
  for (const p of trend) {
    failed += p.value;
    ended += p.total;
  }
  return { failed, ended };
}

function percent(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

/** A coverage card's KPI, linked to its grid. */
export interface PipelineCardSpec extends KpiSpec {
  readonly href: string;
  readonly placeholder: boolean;
  /** The recipe's raw name, for its links. */
  readonly recipe: string;
  /** Datasets by row status, in grid order (unknown words after). */
  readonly statuses: { word: string; count: number }[];
}

function card(c: PipelineCoverageCard, days: number): PipelineCardSpec {
  const recipe = displaySafeLine(c.recipe);
  const version = displaySafeLine(c.recipe_version);
  const sums = trendSums(c.trend);
  const context: string[] = [];
  const pct = percent(c.covered, c.eligible);
  if (pct !== null) {
    context.push(`${c.covered} of ${c.eligible} eligible datasets at recipe version ${version}`);
    context.push(completeLine(c.complete, c.covered_any_version));
  }
  const problems = (["failed", "stalled", "running"] as const)
    .map((w) => [w, c.by_status[w] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .map(([w, n]) => `${w} ${n}`);
  if (problems.length > 0) context.push(`now: ${problems.join(", ")}`);
  context.push(`${sums.failed} failed of ${sums.ended} ended in ${days} days`);
  return {
    key: `pipeline.${c.recipe}`,
    label: `${recipe} coverage`,
    value: pct ?? PIPELINE_LABELS.noEligible,
    muted: pct === null,
    delta: null,
    context,
    spark:
      c.trend.length > 1
        ? {
            label: PIPELINE_LABELS.failedRuns,
            points: c.trend.map((p) => ({ at: p.at, value: p.value })),
            format: "count",
            cadence: "daily",
          }
        : null,
    anchor: null,
    href: gridHref(c.recipe),
    placeholder: c.placeholder,
    recipe: c.recipe,
    statuses: statusCounts(c.by_status),
  };
}

/** One card per recipe; the overview leaves placeholder recipes out, the landing page keeps them. */
export function pipelineCoverageCards(
  res: PipelineCoverage,
  options: { placeholders: boolean },
): PipelineCardSpec[] {
  return res.recipes
    .filter((c) => options.placeholders || !c.placeholder)
    .map((c) => card(c, res.days));
}

/** The status counts of a summary in grid order, then any word this build does not know. */
export function statusCounts(
  byStatus: Readonly<Record<string, number>>,
): { word: string; count: number }[] {
  const known = COMPUTE_PIPELINE_GRID_STATUSES.map((w) => ({ word: w, count: byStatus[w] ?? 0 }));
  const extra = Object.entries(byStatus)
    .filter(([w]) => !(COMPUTE_PIPELINE_GRID_STATUSES as readonly string[]).includes(w))
    .map(([word, count]) => ({ word, count }));
  return [...known, ...extra];
}

/** The grid's first line, as the CLI prints it. */
export function summaryLine(s: {
  recipe: string;
  recipe_version: string;
  covered: number;
  eligible: number;
  complete: number;
  covered_any_version: number;
}): string {
  const pct = s.eligible === 0 ? "0%" : (percent(s.covered, s.eligible) ?? "0%");
  return summaryText({
    recipe: displaySafeLine(s.recipe),
    recipeVersion: displaySafeLine(s.recipe_version),
    covered: s.covered,
    eligible: s.eligible,
    percent: pct,
    complete: s.complete,
    anyVersion: s.covered_any_version,
  });
}
