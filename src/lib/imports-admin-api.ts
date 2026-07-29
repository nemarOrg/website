/**
 * Admin imports API client: list `import_jobs` rows and drive the three
 * operator actions on a stuck import (retry / verify / rollback), plus a
 * fail-soft needs-attention count for the Imports tab badge.
 *
 * Follows the `users-admin-api.ts` client pattern: SSR callers pass
 * `cookieHeader` and hit `api.nemar.org` directly; browser callers omit it
 * and go through the same-origin `/api/v1` proxy (`dashboardApiBase` in
 * `./api-base.ts`) so the `Domain=app.nemar.org` session cookie attaches
 * automatically.
 *
 * Backend contract: `nemar-cli` backend/src/routes/admin/imports.ts
 * (registerImportRoutes), mounted at `/admin/*` behind `authMiddleware` +
 * `adminMiddleware`. Like the users routes, these handlers put a
 * human-readable sentence straight in the `error` field ("Import is
 * 'complete', not failed/quarantined; refusing rollback") rather than a
 * short machine code, so every throw below prefers
 * `detail.message ?? detail.code ?? res.statusText` — the code IS the
 * useful text here.
 *
 * Every fetch carries a deadline (`resolveSignal` from `request-deadline.ts`):
 * a plain `try/catch` only covers outright network rejection, not a connection
 * that opens and never writes a response. `fetchImportsAttentionCount` is
 * awaited from the shared `AdminLayout` on every admin page, so an unbounded
 * fetch here would hang the whole admin section rather than just this one view.
 */
import { dashboardApiBase, readError } from "./api-base";
import { DashboardApiError } from "./dashboard-api";
import { DEFAULT_REQUEST_TIMEOUT_MS, resolveSignal } from "./request-deadline";

/**
 * Lifecycle of an `import_jobs` row. Mirrors `IMPORT_STATUSES` in
 * nemar-cli `backend/src/services/import-recovery.ts` exactly, including
 * order.
 *
 * `incomplete` is the subtle one: it means the import reached `complete`
 * once but S3 is missing keys, and the retry engine actively works it back
 * toward `complete`. It is deliberately not terminal.
 */
export type ImportStatus =
  | "preparing"
  | "copying"
  | "finalizing"
  | "complete"
  | "incomplete"
  | "failed"
  | "quarantined"
  | "rolled_back";

export const IMPORT_STATUSES: readonly ImportStatus[] = [
  "preparing",
  "copying",
  "finalizing",
  "complete",
  "incomplete",
  "failed",
  "quarantined",
  "rolled_back",
];

/**
 * The statuses that put a row in front of a human. These are exactly the
 * statuses the retry endpoint accepts, and a superset of the two the
 * rollback endpoint accepts. Order is triage order: `failed` needs a
 * decision, `quarantined` needs a decision, `incomplete` is already being
 * worked by the retry engine and only needs watching.
 */
export const ATTENTION_STATUSES: readonly ImportStatus[] = ["failed", "quarantined", "incomplete"];

/**
 * Imports currently moving through the pipeline. Mirrors the observability
 * Worker's `imports.active` metric, which sums the same three statuses
 * (`nemar-observability` src/lib/metrics.ts).
 */
export const IN_FLIGHT_STATUSES: readonly ImportStatus[] = ["preparing", "copying", "finalizing"];

/**
 * Row shape from `GET /admin/imports`. Explicit column projection from the
 * `import_jobs` table — the handler selects these seventeen columns by name,
 * so this is the whole row as far as the website is concerned.
 *
 * Nullability here tracks the D1 schema column by column rather than
 * defaulting everything to nullable. `import_jobs` is not the catalog
 * `datasets` table: the fields below that are non-null are declared
 * `NOT NULL` in migration 0044 (`source`, `source_id`, `stage`,
 * `created_at`, `updated_at`) or `NOT NULL DEFAULT 0` in migration 0058
 * (`recovery_attempts`, `blocklisted`, which backfills every pre-existing
 * row), and the write paths supply them unconditionally. Marking those
 * optional anyway would bury the fields that genuinely *are* optional
 * (`last_error`, `next_retry_at`, …) in uniform noise and grow dead `??`
 * guards downstream.
 */
export interface ImportJob {
  readonly dataset_id: string;
  readonly source: string;
  readonly source_id: string;
  readonly stage: string;
  readonly status: ImportStatus;
  readonly last_error: string | null;
  readonly workflow_run_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  /** Automatic retry-engine dispatches burned so far (manual retries don't count). */
  readonly recovery_attempts: number;
  readonly first_incomplete_at: string | null;
  /** When the retry sweep will next consider this row. */
  readonly next_retry_at: string | null;
  /** D1 stores this as an INTEGER (0/1), not a JSON boolean. */
  readonly blocklisted: number;
  readonly blocklist_reason: string | null;
  readonly maintainer_notified_at: string | null;
  readonly integrity_checked_at: string | null;
}

export interface ImportListResponse {
  readonly imports: readonly ImportJob[];
  readonly total: number;
  /**
   * Fleet-wide count per status, by explicit backend contract: it is
   * computed with its own unfiltered `GROUP BY` and is NOT narrowed by the
   * `status`/`blocklisted` query params. That's what makes it usable for
   * the chip counts and the tab badge no matter which filter is applied.
   */
  readonly by_status: Readonly<Record<string, number>>;
}

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  /** Abort the request after this many ms. See {@link IMPORT_TIMEOUTS_MS}. */
  readonly timeoutMs?: number;
};

/**
 * Per-operation request deadlines, exported so the differences between them
 * are a pinned contract rather than four loose magic numbers — reverting
 * `verify` or `rollback` to the base deadline is a silent regression that
 * aborts healthy calls, so `imports-admin-api.test.ts` asserts the ordering
 * here.
 *
 * Caveat worth knowing: these tests pin the *values*, not the wiring.
 * `AbortSignal.timeout()` doesn't expose its duration, and this project
 * tests deadlines by driving the real abort path rather than faking timers
 * (see `.context/handoff.md`), so "does `verifyImport` actually pass
 * `verify` here" is not covered by a unit test.
 *
 * - `default` — a plain D1-backed read or state flip.
 * - `verify` — re-reads every S3 key for the dataset version, so it is
 *   legitimately slower than a D1 read. A 5s deadline would abort healthy
 *   checks on large datasets and make a working endpoint look broken.
 * - `rollback` — a full cascade delete (GitHub repo, then S3 keys, then
 *   D1); the slowest call in this file by a wide margin.
 * - `badge` — decorative chrome on the critical path of every admin page,
 *   so it gets the tightest deadline of the four.
 */
export const IMPORT_TIMEOUTS_MS = {
  default: DEFAULT_REQUEST_TIMEOUT_MS,
  verify: 30_000,
  rollback: 60_000,
  badge: 2000,
} as const;

function headersFor(init: Init, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (withBody) headers["Content-Type"] = "application/json";
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  return headers;
}

/**
 * Triage order for a merged multi-status view: `failed` (needs a decision)
 * before `quarantined` (needs a decision) before `incomplete` (the retry
 * engine is already working it) before everything else, then most recently
 * updated first.
 *
 * This reproduces the backend's own `ORDER BY`, which puts failed and
 * quarantined on top. It is not load-bearing for the needs-attention view
 * specifically — `ATTENTION_STATUSES` is already in triage order and the
 * per-status responses are concatenated in that same order, so that one
 * merge would come out grouped correctly anyway. It IS load-bearing for
 * `IN_FLIGHT_STATUSES`, whose three statuses all rank equally here and so
 * interleave by recency instead of staying clumped by stage, and it makes
 * the ordering a property of this function rather than of the order a
 * caller happens to pass `statuses` in.
 *
 * Pure and total. `updated_at` is `NOT NULL` in the schema, so the `?? ""`
 * below is not schema defensiveness — it guards the *wire* boundary, which
 * is an unchecked `as ImportListResponse` cast. A malformed response would
 * otherwise throw inside a comparator during SSR, and Astro drops a page
 * whose render throws.
 */
export function sortImportJobs(jobs: readonly ImportJob[]): ImportJob[] {
  const rank = (status: ImportStatus): number => {
    const index = ATTENTION_STATUSES.indexOf(status);
    return index === -1 ? ATTENTION_STATUSES.length : index;
  };
  return [...jobs].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
}

/**
 * True when `POST /admin/imports/:id/retry` would be accepted. The backend
 * `UPDATE ... WHERE status IN ('failed', 'quarantined', 'incomplete')`
 * returns 409 for anything else, so gating the button here avoids offering
 * an action that can only fail.
 */
export function canRetry(job: Pick<ImportJob, "status">): boolean {
  return job.status === "failed" || job.status === "quarantined" || job.status === "incomplete";
}

/**
 * True when `POST /admin/imports/:id/rollback` would get past the status
 * check (409 otherwise). Note this is *necessary but not sufficient*: the
 * backend additionally requires the owner role when the dataset has a
 * concept DOI or is public, and refuses outright for system catalog
 * entries. Neither `concept_doi` nor `visibility` is in the `import_jobs`
 * projection, so the UI genuinely cannot predict that branch — it surfaces
 * the backend's 403 sentence instead of hiding the button on a guess.
 */
export function canRollback(job: Pick<ImportJob, "status">): boolean {
  return job.status === "failed" || job.status === "quarantined";
}

/** True for a row parked by the retry engine's blocklist (#969). */
export function isBlocklisted(job: Pick<ImportJob, "blocklisted">): boolean {
  return job.blocklisted === 1;
}

/**
 * True for a quarantined row that failed because OpenNeuro's objects aren't
 * anonymously readable, rather than because anything on the NEMAR side went
 * wrong (nemar-cli#818 keeps the marker sticky across state callbacks;
 * nemar-cli#827 is the weekly OpenNeuro-support report built on it).
 *
 * Borrowed from the observability Worker, which surfaces exactly this as its
 * own `imports.upstream_inaccessible` metric using the same `last_error`
 * match (`nemar-observability` src/lib/drilldown.ts). It earns a place in
 * the triage UI because it is the one quarantine an operator cannot clear by
 * retrying: the bytes stay unreachable until someone upstream changes the
 * object ACLs, so the row belongs on a "report to OpenNeuro" list rather
 * than in the retry lane.
 *
 * Substring match, deliberately: the backend writes the marker inside a
 * longer human-readable error sentence.
 */
export function isUpstreamInaccessible(job: Pick<ImportJob, "last_error">): boolean {
  return (job.last_error ?? "").includes("upstream_inaccessible");
}

/**
 * Sums selected statuses out of a fleet-wide `by_status` map. Tolerates
 * missing keys: the backend pre-seeds every known status to 0, but a status
 * added upstream before this client learns about it must not turn the count
 * into `NaN`.
 */
export function sumStatuses(
  byStatus: Readonly<Record<string, number>>,
  statuses: readonly ImportStatus[],
): number {
  return statuses.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0);
}

/** Total imports on record, summed across every status the backend reports. */
export function totalCount(byStatus: Readonly<Record<string, number>>): number {
  return Object.values(byStatus).reduce((sum, n) => sum + (n ?? 0), 0);
}

/** Convenience for the tab badge and the default chip: failed + quarantined + incomplete. */
export function attentionCount(byStatus: Readonly<Record<string, number>>): number {
  return sumStatuses(byStatus, ATTENTION_STATUSES);
}

export async function listAdminImports(
  query: { status?: ImportStatus; blocklisted?: boolean } = {},
  init: Init = {},
): Promise<ImportListResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.blocklisted !== undefined) params.set("blocklisted", query.blocklisted ? "1" : "0");
  const qs = params.toString();
  const url = `${dashboardApiBase(init.cookieHeader)}/admin/imports${qs ? `?${qs}` : ""}`;
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: headersFor(init, false),
    credentials: "include",
    signal: resolveSignal(init, IMPORT_TIMEOUTS_MS.default),
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Could not list imports: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as ImportListResponse;
}

/**
 * Lists several statuses as one view, in triage order. Backs both the
 * default needs-attention chip ({@link ATTENTION_STATUSES}) and the
 * in-flight chip ({@link IN_FLIGHT_STATUSES}).
 *
 * One request per status rather than one unfiltered dump because the
 * endpoint has no pagination and `status` is single-valued: an unfiltered
 * call returns a row for every import ever attempted, the overwhelming
 * majority of them `complete` and irrelevant to triage. A row has exactly
 * one status, so concatenating disjoint single-status responses cannot
 * produce duplicates.
 *
 * `by_status` is fleet-wide and therefore identical across all responses;
 * the first that succeeded is authoritative for the chip counts.
 *
 * Partial failure is reported, not hidden, and not fatal. `Promise.all`
 * would discard two good status queries because a third hiccuped, blanking
 * the default landing view of the whole page; silently dropping the failed
 * one would be worse still, because "no failed imports" and "we couldn't
 * ask about failed imports" would render identically and the second reads
 * as good news. So successful statuses render and `failedStatuses` names
 * the ones whose state is unknown, for the page to surface alongside them.
 * Only a total wipeout throws.
 */
export interface MultiStatusImportListResponse extends ImportListResponse {
  /** Statuses whose query failed; their rows are absent from `imports`. */
  readonly failedStatuses: readonly ImportStatus[];
}

export async function listImportsByStatuses(
  statuses: readonly ImportStatus[],
  init: Init = {},
): Promise<MultiStatusImportListResponse> {
  const settled = await Promise.allSettled(
    statuses.map((status) => listAdminImports({ status }, init)),
  );
  const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failedStatuses = statuses.filter((_, i) => settled[i].status === "rejected");

  // Every status failed: there is nothing to show and nothing partial to
  // explain, so behave like the single-status call and let the page render
  // its error state. Rethrows the first rejection so the operator sees the
  // backend's actual sentence rather than a synthesized one.
  if (ok.length === 0 && statuses.length > 0) {
    const firstRejection = settled.find((r) => r.status === "rejected");
    throw (firstRejection as PromiseRejectedResult).reason;
  }

  for (const status of failedStatuses) {
    console.warn(`[imports-admin-api] status query failed, omitting from view: ${status}`);
  }

  const imports = sortImportJobs(ok.flatMap((r) => r.imports));
  return {
    imports,
    total: imports.length,
    by_status: ok[0]?.by_status ?? {},
    failedStatuses,
  };
}

export interface ImportRetryResult {
  readonly ok: true;
  readonly dataset_id: string;
  readonly status: "preparing";
}

export async function retryImport(datasetId: string, init: Init = {}): Promise<ImportRetryResult> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/imports/${encodeURIComponent(datasetId)}/retry`,
    {
      method: "POST",
      headers: headersFor(init, true),
      credentials: "include",
      body: "{}",
      signal: resolveSignal(init, IMPORT_TIMEOUTS_MS.default),
    },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Retry failed: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as ImportRetryResult;
}

/**
 * Result of a forced S3 integrity check. Note the backend may also change
 * the row's status as a side effect (recovering a verified-complete row, or
 * reclassifying a `complete` row that fails the check to `incomplete`), so
 * a rendered row is stale once this resolves.
 */
export interface ImportVerifyResult {
  readonly dataset_id: string;
  readonly complete: boolean;
  readonly missingKeys: readonly string[];
  readonly zeroByteKeys: readonly string[];
  readonly expectedCount: number;
  readonly presentCount: number;
}

export async function verifyImport(
  datasetId: string,
  init: Init = {},
): Promise<ImportVerifyResult> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/imports/${encodeURIComponent(datasetId)}/verify`,
    {
      method: "POST",
      headers: headersFor(init, true),
      credentials: "include",
      body: "{}",
      signal: resolveSignal(init, IMPORT_TIMEOUTS_MS.verify),
    },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Verify failed: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as ImportVerifyResult;
}

/**
 * Result of a rollback cascade.
 *
 * **`ok`/`rolled_back` false is a failure delivered with HTTP 200.** A
 * partial cascade (say the GitHub repo went but S3 keys remain) leaves the
 * row `quarantined` with the warnings recorded, deliberately refusing to
 * claim a clean rollback. Callers must branch on `rolled_back`, not on
 * `res.ok` — see {@link rollbackImport}, which converts that case into a
 * thrown error so no caller can mistake it for success.
 *
 * Modeled as a discriminated union rather than two independent booleans
 * because the backend always writes `ok` and `rolled_back` together (see
 * imports.ts, both the partial and clean branches) — a split state like
 * `{ok: true, rolled_back: false}` is unrepresentable here rather than
 * merely undocumented. Mirrors the `DatasetPublishState` precedent in
 * `dashboard-api.ts`.
 */
interface ImportRollbackBase {
  readonly dataset_id: string;
  readonly steps: readonly string[];
  readonly warnings: readonly string[];
}

export type ImportRollbackResult =
  | (ImportRollbackBase & { readonly ok: true; readonly rolled_back: true })
  | (ImportRollbackBase & { readonly ok: false; readonly rolled_back: false });

/**
 * Runs the rollback cascade (GitHub repo + S3 + D1 delete, then marks the
 * import row `rolled_back`).
 *
 * Throws on a partial cascade even though that arrives as HTTP 200 — the
 * dataset is in a half-deleted state that needs the operator's attention,
 * and the one thing the UI must not do is flash a success and reload. The
 * backend's own warnings are joined into the message because they name
 * exactly which cascade step was left behind.
 */
export async function rollbackImport(
  datasetId: string,
  init: Init = {},
): Promise<ImportRollbackResult> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/imports/${encodeURIComponent(datasetId)}/rollback`,
    {
      method: "POST",
      headers: headersFor(init, true),
      credentials: "include",
      body: "{}",
      signal: resolveSignal(init, IMPORT_TIMEOUTS_MS.rollback),
    },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Rollback failed: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  const body = (await res.json()) as ImportRollbackResult;
  if (!body.rolled_back) {
    const warnings = body.warnings?.length ? `: ${body.warnings.join("; ")}` : ".";
    throw new DashboardApiError(
      `Rollback incomplete — ${datasetId} is partly deleted and stays quarantined${warnings}`,
      res.status,
      "rollback_incomplete",
    );
  }
  return body;
}

/**
 * Fail-soft count of imports needing attention (failed + quarantined +
 * incomplete), for the Imports tab badge rendered by every admin page via
 * `AdminLayout`. Never throws — mirrors `fetchAwaitingApprovalCount` in
 * `users-admin-api.ts` — because a transient nemar-cli hiccup must degrade
 * to "no badge shown" rather than break the shared admin shell.
 *
 * The `status` filter is here purely to bound the response body: the badge
 * needs only `by_status`, which the backend computes fleet-wide regardless
 * of the filter, while an unfiltered call would drag down a row for every
 * import ever attempted on every single admin page load. `quarantined` is
 * the narrowest of the three attention statuses in practice.
 *
 * Logs before degrading. `null` (couldn't ask) and `0` (nothing to triage)
 * both render as "no badge", so without a log line a broken imports
 * subsystem is indistinguishable from a healthy quiet one — and the
 * indistinguishable one reads as good news. The log is the only trail an
 * operator has; `console.*` from the Worker lands in Workers Logs.
 */
export async function fetchImportsAttentionCount(init: Init = {}): Promise<number | null> {
  try {
    const { by_status } = await listAdminImports(
      { status: "quarantined" },
      { ...init, timeoutMs: init.timeoutMs ?? IMPORT_TIMEOUTS_MS.badge },
    );
    return attentionCount(by_status);
  } catch (err) {
    console.warn(
      "[imports-admin-api] attention-count badge degraded to null:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
