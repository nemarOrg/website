/**
 * The admin Pipelines tab's words (nemar-cli ADR 0134 decision 5; epic nemarOrg/nemar-cli#2324
 * phase 4b, website#586). Website-owned, not account-copy keys: nemar-cli reads nothing here, so
 * the merge order stays one-directional (nemar-cli `dev` first, website `staging` second).
 *
 * Two groups:
 *
 *   PIPELINE_LABELS  short labels for this surface only (headings, column names, buttons, notes).
 *   PIPELINE_HELP    the sentences that say what a status, a mark, the coverage and the lag MEAN.
 *                    Each is the CLI's own wording: `test/compute-pipeline-cli-parity.test.ts` checks
 *                    that every one appears, whitespace collapsed, in the captured
 *                    `nemar admin compute pipeline status|failures --help-all` text, so the page and
 *                    the command never explain the same grid two ways.
 *
 * The `.astro` pages hold no multi-word literal; they read from here (a source scan pins it).
 */

import { PROGRESS_MAX_FAILURES } from "./compute-pipeline-contract";

export const PIPELINE_LABELS = {
  tab: "Pipelines",
  lede: "NEMAR's own processing runs, recipe by recipe: how many eligible datasets each recipe covers, where each dataset's newest run stopped, and which recordings failed. Read only.",
  overviewHeading: "Processing recipes",
  overviewLede: "Coverage of each recipe over the eligible datasets, and failed runs per day.",
  landingHeading: "Recipes",
  gridHeading: "Datasets by checkpoint",
  legendHeading: "What a cell shows",
  filtersHeading: "Filters",
  allStatuses: "All",
  recipeVersion: "Recipe version",
  anyVersion: "Any version",
  executor: "Executor",
  anyExecutor: "Any executor",
  runner: "Runner",
  anyRunner: "Any runner",
  dataset: "Dataset",
  apply: "Apply",
  clearFilters: "Clear filters",
  nextPage: "Next page",
  firstPage: "First page",
  pagerLabel: "Grid pages",
  colDataset: "Dataset",
  colVersion: "Version",
  colRun: "Run",
  colExecutor: "Executor",
  colStatus: "Status",
  olderVersion: "older version",
  unreadable: "unreadable",
  placeholder: "placeholder",
  noEligible: "No eligible datasets",
  noRecipes: "The registry lists no recipes.",
  noMatches: "No datasets match these filters.",
  noMore: "No more datasets on this page.",
  matching: "Matching",
  notARecipe: "This address does not name a recipe.",
  placeholderNote: "This recipe is a placeholder: it is not dispatched automatically yet.",
  notAvailableTitle: "Not available on this server yet",
  notAvailableBody:
    "This API does not serve the pipeline routes yet; they arrive with the nemar-cli release that carries them.",
  coverageNoHistory: "Coverage history is not recorded yet; the trend counts failed runs per day.",
  coverageHistoryIssue: "Tracking issue",
  failedRuns: "Failed runs",
  readOnlyLead:
    'This page reads without a sync; "nemar admin compute pipeline status" syncs first.',
  asOf: "As of",
  ignoredFilter: "Ignored a filter that is not valid:",
  runnerNotTapis: "A runner's jobs are not Tapis jobs: drop the Tapis executor or the runner.",
  backToGrid: "Back to the grid",
  backToRecipes: "Back to the recipes",
  runHeading: "Pipeline run",
  runNotFoundTitle: "No such pipeline run",
  runNotFoundBody: "There is no pipeline stamp with this id.",
  checkpointsHeading: "Checkpoints",
  codesHeading: "Listed failure codes",
  colPath: "Recording",
  colCode: "Code",
  colStep: "Step",
  colCheckpoint: "Checkpoint",
  colCount: "Listed",
  liveCounts: "Last live report",
  disagreement: "The live counts and the recordings table disagree.",
  failuresUnreadable: "This checkpoint's failure list could not be read.",
  allTableIssue: "Paging the whole recordings table is tracked here",
  fieldStamp: "Stamp",
  fieldDataset: "Dataset",
  fieldVersion: "Version",
  fieldRecipe: "Recipe",
  fieldRecipeVersion: "Recipe version",
  fieldInput: "Input",
  fieldStatus: "Status",
  fieldOutcome: "Outcome",
  fieldJob: "Job",
  fieldJobState: "Job state",
  fieldExecutor: "Executor",
  fieldReports: "Reports",
  fieldLastReport: "Last report",
  none: "none",
} as const;

/** The CLI's sentences, as they appear in its help (whitespace aside). */
export const PIPELINE_HELP = {
  grid: "one recipe's runs over the eligible datasets, like the legacy pipeline status table",
  columns:
    "a row per dataset, a column per checkpoint the recipe declares (then stored, set when the derivatives are copied)",
  row: "A row shows the dataset's newest run of the recipe (any of its versions; never a refusal or a hold)",
  notStarted: "not_started (no run)",
  waiting: "waiting (dispatched, not started, no report yet)",
  legend: [
    "F<n> n recordings failed there",
    "x the rest were skipped (they failed earlier)",
    "R running",
    "S stalled",
    "W waiting",
    "P pending (the run ended and its counts, or the stored checkpoint, are not reconciled yet)",
    "? no counts (the run ended without a readable recordings table, its job never reported, or it ended with no job)",
    "- not started",
  ],
  coverage:
    "datasets whose newest version has a succeeded run of the registry's current recipe version, out of the eligible ones; complete is covered with every recording passed at the recipe's last checkpoint before stored; \"at any recipe version\" counts older recipe versions too. Coverage counts a finished run once a sync has recorded its end.",
  lag: "A run's status is right either way; without a sync, ended runs are not reconciled yet and the coverage line can lag until a sync records them.",
  unlisted:
    "how many of the recordings that stopped at that checkpoint (failed or skipped there, not earlier) are not listed",
} as const;

/** What "stalled" means, with the Worker's own threshold (`stalled_after_seconds`, in minutes). */
export function stalledMeaning(minutes: number): string {
  return `stalled (its last report is more than ${minutes} minutes old while the job is submitted, queued or running, or the job's state is unreported; a submitted, queued or running job that never sent a progress report is never stalled)`;
}

/** How many failures a checkpoint lists, and which ones. */
export function failuresMeaning(max: number = PROGRESS_MAX_FAILURES): string {
  return `A checkpoint lists at most ${max} (the first ones of the recordings table once the run is reconciled, the most recent ones while it reports)`;
}

/** What a checkpoint's list leaves out (the CLI prints the same count as "and N more"). */
export function unlistedText(count: number): string {
  return `and ${count} more recordings that stopped here are not listed.`;
}

/** A checkpoint's counts in words. */
export function countsText(c: {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}): string {
  return `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped of ${c.total}`;
}
