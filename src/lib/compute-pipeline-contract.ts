/**
 * Hand copy of the words and bounds the admin Pipelines tab branches on (nemar-cli ADR 0134
 * decision 5; epic nemarOrg/nemar-cli#2324 phase 4b, website#586).
 *
 * A LEAF: it imports nothing, so the drift test reads it as text and so can any page. Every list
 * and number here is a literal copied from nemar-cli, and
 * `test/compute-pipeline-contract-drift.test.ts` compares each one with its source of truth:
 *
 *   shared/contract/compute-admin.ts   the grid words, the bounds, the stamp and recipe-version
 *                                      patterns, `stamp_not_found`
 *   shared/compute-recipes.ts          the checkpoint names and their order
 *   shared/contract/compute-runner.ts  a runner id
 *   shared/contract/compute.ts         a dataset id
 *   shared/contract/compute-progress.ts the most failures a checkpoint lists
 *
 * The routes' contract is OPEN: a word the Worker grows arrives as a string the page shows raw in
 * a neutral tone, so these lists say what the page knows how to draw, not what it accepts.
 * The executors are already pinned in `compute-admin-contract.ts`; reuse them from there.
 */

/** What a dataset's row shows: `not_started` (no run), or its run's status. */
export const COMPUTE_PIPELINE_GRID_STATUSES = [
  "not_started",
  "waiting",
  "running",
  "stalled",
  "finished",
  "failed",
] as const;
export type ComputePipelineGridStatus = (typeof COMPUTE_PIPELINE_GRID_STATUSES)[number];

/** The mark of a cell. */
export const COMPUTE_PIPELINE_CELL_MARKS = [
  "not_started",
  "waiting",
  "running",
  "stalled",
  "pending",
  "no_counts",
  "passed",
  "failed",
  "skipped",
] as const;
export type ComputePipelineCellMark = (typeof COMPUTE_PIPELINE_CELL_MARKS)[number];

/** What reconciliation decided for a run that ended. */
export const COMPUTE_PIPELINE_RUN_OUTCOMES = [
  "reconciled",
  "table_missing",
  "table_unreadable",
  "no_checkpoint_map",
  "recipe_unknown",
] as const;

/** Rows of the grid per page, by default and at most. */
export const COMPUTE_PIPELINE_GRID_PAGE_DEFAULT = 100;
export const COMPUTE_PIPELINE_GRID_PAGE_MAX = 500;

/** Days of the coverage card's failure trend, by default and at most. */
export const COMPUTE_PIPELINE_TREND_DAYS_DEFAULT = 30;
export const COMPUTE_PIPELINE_TREND_DAYS_MAX = 90;

/** A pipeline stamp id: a whole number of up to 16 digits (the caller also checks it is safe). */
export const COMPUTE_PIPELINE_STAMP_ID_RE = /^[1-9][0-9]{0,15}$/;

/** A recipe version, as the stamps and the registry write it. */
export const COMPUTE_PIPELINE_RECIPE_VERSION_RE = /^[0-9A-Za-z._+-]{1,64}$/;

/**
 * The checkpoint names in their standard order (`shared/compute-recipes.ts`). No `figures`: quality
 * views are data drawn in the browser and are written at `quality` (nemar-cli ADR 0137, website
 * ADR 0035).
 */
export const STANDARD_CHECKPOINTS = [
  "import",
  "preprocess",
  "ica",
  "iclabel",
  "quality",
  "stored",
] as const;

/** The checkpoint the backend sets when the derivatives are copied. */
export const STORED_CHECKPOINT = "stored";

/** A runner id (`shared/contract/compute-runner.ts`). */
export const RUNNER_ID_RE = /^rnr_[0-9a-f]{24}$/;

/** A dataset id (`shared/contract/compute.ts`). */
export const COMPUTE_DATASET_ID_RE = /^[a-z]{2}[0-9]{6}$/;

/** The most failures a checkpoint lists (`shared/contract/compute-progress.ts`). */
export const PROGRESS_MAX_FAILURES = 10;

/** The refusal word of a drill-down that names a stamp that does not exist. */
export const PIPELINE_STAMP_NOT_FOUND = "stamp_not_found";

/** The grid's refusal word for a recipe the registry does not have (a 422; the page answers 404). */
export const PIPELINE_RECIPE_UNKNOWN = "recipe_unknown";

/**
 * A recipe name in a path. It mirrors nemar-cli's route-local `RECIPE_NAME`
 * (backend/src/routes/admin/compute-pipeline.ts), which is not exported from a shared contract yet,
 * so it cannot be drift-pinned; nemarOrg/nemar-cli#2338 asks to export it. A malformed segment is never sent
 * to the API; the backend still decides whether the recipe exists.
 */
export const PIPELINE_RECIPE_SEGMENT_RE = /^[a-z][a-z0-9-]{0,63}$/;
