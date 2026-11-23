/**
 * Admin Pipelines client: the three READ-ONLY routes under `/admin/compute/pipeline/*` (nemar-cli
 * ADR 0134 decision 5; epic nemarOrg/nemar-cli#2324 phase 4b, website#586):
 *
 *   GET /admin/compute/pipeline/coverage?days=   one card per recipe with its daily failure trend
 *   GET /admin/compute/pipeline/grid?...         a page of datasets by checkpoints
 *   GET /admin/compute/pipeline/runs/<id>        one run's checkpoints and the failures each lists
 *
 * NEVER A SYNC. The grid route syncs the open stamps first when asked with `sync=1`, which costs the
 * Worker hundreds of subrequests; the CLI asks, the website never does. There is no `sync` field in
 * {@link PipelineGridQuery} and {@link pipelineGridSearch} cannot write one.
 *
 * Transport, errors and the malformed-answer rule are the admin Compute client's (`computeFetch`,
 * `ComputeAdminApiError`, `computeAdminErrorText`). Guards are hand-written for an OPEN contract:
 * an extra key is tolerated and every word is a string, but a missing or wrongly typed required key
 * is a shape error for the whole answer, never an empty list or a zero. One exception: a grid cell
 * is guarded on its own ({@link parsePipelineCell}), so one unreadable cell shows as unreadable
 * rather than failing the page, as the CLI's `cellText` does.
 *
 * Times are D1's own (`YYYY-MM-DD HH:MM:SS`, UTC). Never `Date.parse` one: that string parses as
 * local time. The page prints them as served with " UTC".
 */

import {
  ComputeAdminApiError,
  type ComputeAdminInit,
  MALFORMED_SENTENCE,
  computeFetch,
} from "./compute-admin-api";

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function fail(): never {
  throw new ComputeAdminApiError(200, undefined, MALFORMED_SENTENCE);
}

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Dict;
}
function str(value: unknown): string {
  if (typeof value !== "string") fail();
  return value;
}
function int(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail();
  return value;
}
/** A string or null; an absent key reads as null (an older Worker may not send it). */
function strOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return str(value);
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PipelineCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
}

function counts(value: unknown): PipelineCounts {
  const d = dict(value);
  return {
    passed: int(d.passed),
    failed: int(d.failed),
    skipped: int(d.skipped),
    total: int(d.total),
  };
}
function countsOrNull(value: unknown): PipelineCounts | null {
  return value === null ? null : counts(value);
}

/** Counts by grid status; every word is a key, whatever it is. */
export type PipelineByStatus = Readonly<Record<string, number>>;

function byStatus(value: unknown): PipelineByStatus {
  const d = dict(value);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) out[k] = int(v);
  return out;
}

/** The run a row shows. No identity: a runner is named by its id and its fixed name. */
export interface PipelineRunView {
  readonly stamp_id: number;
  readonly dataset_id: string;
  readonly recipe: string;
  readonly version: string;
  readonly current_version: boolean;
  readonly recipe_version: string;
  readonly engine: string;
  readonly input: string;
  readonly attempt: number;
  readonly stamp_state: string;
  readonly code: string | null;
  readonly job_id: string | null;
  readonly job_state: string | null;
  readonly executor: string | null;
  readonly runner_id: string | null;
  readonly runner_name: string | null;
  readonly checkpoint: string | null;
  readonly reported_at: string | null;
  readonly reports: number;
  readonly reconciled: boolean;
  readonly outcome: string | null;
  readonly disagreement: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export function parseRunView(value: unknown): PipelineRunView {
  const d = dict(value);
  return {
    stamp_id: int(d.stamp_id),
    dataset_id: str(d.dataset_id),
    recipe: str(d.recipe),
    version: str(d.version),
    current_version: bool(d.current_version),
    recipe_version: str(d.recipe_version),
    engine: str(d.engine),
    input: str(d.input),
    attempt: int(d.attempt),
    stamp_state: str(d.stamp_state),
    code: strOrNull(d.code),
    job_id: strOrNull(d.job_id),
    job_state: strOrNull(d.job_state),
    executor: strOrNull(d.executor),
    runner_id: strOrNull(d.runner_id),
    runner_name: strOrNull(d.runner_name),
    checkpoint: strOrNull(d.checkpoint),
    reported_at: strOrNull(d.reported_at),
    reports: int(d.reports),
    reconciled: bool(d.reconciled),
    outcome: strOrNull(d.outcome),
    disagreement: bool(d.disagreement),
    created_at: str(d.created_at),
    updated_at: str(d.updated_at),
  };
}

export interface PipelineCell {
  readonly mark: string;
  readonly counts: PipelineCounts | null;
  readonly reconciled: boolean;
  readonly disagreement: boolean;
  /** Failures the cell lists (at most ten). */
  readonly listed: number;
}

/** One cell, or null when it is unreadable: the page shows `?` for it and keeps the rest. */
export function parsePipelineCell(value: unknown): PipelineCell | null {
  try {
    const d = dict(value);
    return {
      mark: str(d.mark),
      counts: countsOrNull(d.counts),
      reconciled: bool(d.reconciled),
      disagreement: bool(d.disagreement),
      listed: int(d.listed),
    };
  } catch {
    return null;
  }
}

export interface PipelineGridRow {
  readonly dataset_id: string;
  readonly newest_version: string | null;
  readonly status: string;
  readonly run: PipelineRunView | null;
  /** One cell per column; an unreadable one is null. */
  readonly cells: Readonly<Record<string, PipelineCell | null>>;
}

function gridRow(value: unknown): PipelineGridRow {
  const d = dict(value);
  const cells: Record<string, PipelineCell | null> = {};
  for (const [k, v] of Object.entries(dict(d.cells))) cells[k] = parsePipelineCell(v);
  return {
    dataset_id: str(d.dataset_id),
    newest_version: strOrNull(d.newest_version),
    status: str(d.status),
    run: d.run === null ? null : parseRunView(d.run),
    cells,
  };
}

/** A recipe's coverage over the eligible datasets. */
export interface PipelineRecipeSummary {
  readonly recipe: string;
  readonly recipe_version: string;
  readonly placeholder: boolean;
  readonly auto_dispatch: boolean;
  readonly columns: readonly string[];
  readonly eligible: number;
  readonly covered: number;
  readonly complete: number;
  readonly covered_any_version: number;
  readonly by_status: PipelineByStatus;
}

function summary(value: unknown): PipelineRecipeSummary {
  const d = dict(value);
  return {
    recipe: str(d.recipe),
    recipe_version: str(d.recipe_version),
    placeholder: bool(d.placeholder),
    auto_dispatch: bool(d.auto_dispatch),
    columns: arr(d.columns).map(str),
    eligible: int(d.eligible),
    covered: int(d.covered),
    complete: int(d.complete),
    covered_any_version: int(d.covered_any_version),
    by_status: byStatus(d.by_status),
  };
}

export interface PipelineRunner {
  readonly id: string;
  readonly name: string;
}

export interface PipelineGridPage {
  readonly as_of: string;
  readonly stalled_after_seconds: number;
  readonly recipe: string;
  readonly columns: readonly string[];
  readonly summary: PipelineRecipeSummary;
  /** Over the whole filtered set, not only this page. */
  readonly matched: { readonly total: number; readonly by_status: PipelineByStatus };
  readonly facets: {
    readonly recipe_versions: readonly string[];
    readonly runners: readonly PipelineRunner[];
  };
  readonly rows: readonly PipelineGridRow[];
  readonly next_after: string | null;
}

export function parseGridPage(value: unknown): PipelineGridPage {
  const d = dict(value);
  const matched = dict(d.matched);
  const facets = dict(d.facets);
  return {
    as_of: str(d.as_of),
    stalled_after_seconds: int(d.stalled_after_seconds),
    recipe: str(d.recipe),
    columns: arr(d.columns).map(str),
    summary: summary(d.summary),
    matched: { total: int(matched.total), by_status: byStatus(matched.by_status) },
    facets: {
      recipe_versions: arr(facets.recipe_versions).map(str),
      runners: arr(facets.runners).map((r) => {
        const x = dict(r);
        return { id: str(x.id), name: str(x.name) };
      }),
    },
    rows: arr(d.rows).map(gridRow),
    next_after: strOrNull(d.next_after),
  };
}

/** One UTC day of the trend: failed runs that ended that day, out of all that ended. */
export interface PipelineTrendPoint {
  readonly at: string;
  readonly value: number;
  readonly total: number;
}

export interface PipelineCoverageCard extends PipelineRecipeSummary {
  readonly trend: readonly PipelineTrendPoint[];
}

export interface PipelineCoverage {
  readonly as_of: string;
  readonly days: number;
  readonly recipes: readonly PipelineCoverageCard[];
}

export function parseCoverage(value: unknown): PipelineCoverage {
  const d = dict(value);
  return {
    as_of: str(d.as_of),
    days: int(d.days),
    recipes: arr(d.recipes).map((r) => ({
      ...summary(r),
      trend: arr(dict(r).trend).map((p) => {
        const x = dict(p);
        return { at: str(x.at), value: int(x.value), total: int(x.total) };
      }),
    })),
  };
}

export interface PipelineFailure {
  readonly path: string;
  readonly code: string;
  readonly step: string | null;
}

export interface PipelineRunCheckpoint {
  readonly checkpoint: string;
  readonly mark: string;
  readonly counts: PipelineCounts | null;
  /** The last live report's counts; null when it never reported. */
  readonly live: PipelineCounts | null;
  readonly reconciled: boolean;
  readonly disagreement: boolean;
  readonly reported_at: string | null;
  readonly failures: readonly PipelineFailure[];
  readonly listed: number;
  /** Recordings that first stopped at this checkpoint and that the list leaves out. */
  readonly unlisted: number;
  readonly failures_unreadable: boolean;
}

export interface PipelineRunDetail {
  readonly status: string;
  readonly newest_version: string | null;
  readonly run: PipelineRunView;
  readonly checkpoints: readonly PipelineRunCheckpoint[];
  readonly listed_codes: readonly {
    readonly checkpoint: string;
    readonly code: string;
    readonly count: number;
  }[];
}

export function parseRunDetail(value: unknown): PipelineRunDetail {
  const d = dict(value);
  return {
    status: str(d.status),
    newest_version: strOrNull(d.newest_version),
    run: parseRunView(d.run),
    checkpoints: arr(d.checkpoints).map((c) => {
      const x = dict(c);
      return {
        checkpoint: str(x.checkpoint),
        mark: str(x.mark),
        counts: countsOrNull(x.counts),
        live: countsOrNull(x.live),
        reconciled: bool(x.reconciled),
        disagreement: bool(x.disagreement),
        reported_at: strOrNull(x.reported_at),
        failures: arr(x.failures).map((f) => {
          const y = dict(f);
          return { path: str(y.path), code: str(y.code), step: strOrNull(y.step) };
        }),
        listed: int(x.listed),
        unlisted: int(x.unlisted),
        failures_unreadable: bool(x.failures_unreadable),
      };
    }),
    listed_codes: arr(d.listed_codes).map((c) => {
      const x = dict(c);
      return { checkpoint: str(x.checkpoint), code: str(x.code), count: int(x.count) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * The grid's query, already checked by the page (`parseGridQuery`). There is deliberately no sync
 * field: the website never asks the Worker to sync.
 */
export interface PipelineGridQuery {
  readonly recipe: string;
  readonly recipe_version?: string;
  readonly executor?: string;
  readonly runner?: string;
  readonly status?: string;
  readonly dataset?: string;
  readonly after?: string;
  readonly limit?: number;
}

const QUERY_KEYS = [
  "recipe",
  "recipe_version",
  "executor",
  "runner",
  "status",
  "dataset",
  "after",
] as const;

/** The grid's search parameters: only the keys {@link PipelineGridQuery} names, never another. */
export function pipelineGridSearch(q: PipelineGridQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = q[key];
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  if (typeof q.limit === "number" && Number.isSafeInteger(q.limit) && q.limit > 0) {
    params.set("limit", String(q.limit));
  }
  return params;
}

export function getPipelineGrid(
  q: PipelineGridQuery,
  init: ComputeAdminInit = {},
): Promise<PipelineGridPage> {
  return computeFetch("GET", `/pipeline/grid?${pipelineGridSearch(q)}`, init, parseGridPage);
}

/** The coverage cards; with no `days` the Worker's default applies (read it back from `days`). */
export function getPipelineCoverage(
  days: number | undefined,
  init: ComputeAdminInit = {},
): Promise<PipelineCoverage> {
  const qs = days === undefined ? "" : `?days=${days}`;
  return computeFetch("GET", `/pipeline/coverage${qs}`, init, parseCoverage);
}

export function getPipelineRun(
  stampId: number,
  init: ComputeAdminInit = {},
): Promise<PipelineRunDetail> {
  return computeFetch("GET", `/pipeline/runs/${stampId}`, init, parseRunDetail);
}
