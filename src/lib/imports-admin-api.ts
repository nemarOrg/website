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
 * Every fetch carries a deadline (mirrors `resolveSignal` in
 * `users-admin-api.ts` / `observability.ts`): a plain `try/catch` only
 * covers outright network rejection, not a connection that opens and never
 * writes a response. `fetchImportsAttentionCount` is awaited from the
 * shared `AdminLayout` on every admin page, so an unbounded fetch here
 * would hang the whole admin section rather than just this one view.
 */
import { dashboardApiBase, readError } from "./api-base";
import { DashboardApiError } from "./dashboard-api";

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
 */
export interface ImportJob {
  readonly dataset_id: string;
  readonly source: string | null;
  readonly source_id: string | null;
  readonly stage: string | null;
  readonly status: ImportStatus;
  readonly last_error: string | null;
  readonly workflow_run_url: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly completed_at: string | null;
  /** Automatic retry-engine dispatches burned so far (manual retries don't count). */
  readonly recovery_attempts: number | null;
  readonly first_incomplete_at: string | null;
  /** When the retry sweep will next consider this row. */
  readonly next_retry_at: string | null;
  /** D1 stores this as an INTEGER (0/1), not a JSON boolean. */
  readonly blocklisted: number | null;
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
  /** Abort the request after this many ms. Defaults to 5000. */
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Verify re-reads every S3 key for the dataset version, so it is legitimately
 * slower than a D1 read. A 5s deadline would abort healthy checks on large
 * datasets and make a working endpoint look broken.
 */
const VERIFY_TIMEOUT_MS = 30_000;

/**
 * Rollback runs a full cascade delete (GitHub repo, then S3 keys, then D1),
 * so it is the slowest call in this file by a wide margin.
 */
const ROLLBACK_TIMEOUT_MS = 60_000;

/** Decorative chrome, on the critical path of every admin page. See below. */
const BADGE_TIMEOUT_MS = 2000;

/**
 * Combines a caller-supplied abort signal (if any) with a deadline. Mirrors
 * `resolveSignal` in `./users-admin-api.ts` deliberately, so every
 * authenticated admin client behaves identically under a hung upstream.
 *
 * A plain `try/catch` around `fetch` only covers outright rejection (refused
 * connection, DNS/TLS failure). It does NOT cover a connection that opens and
 * then never writes a response: that promise simply never settles, so there is
 * nothing to catch. These calls run during SSR, so an unbounded one stalls the
 * page render itself.
 */
function resolveSignal(init: Init, fallbackMs = DEFAULT_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? fallbackMs);
  return init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
}

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
 * This deliberately reproduces the backend's own `ORDER BY` — which puts
 * failed and quarantined on top — because the needs-attention view
 * concatenates three separate single-status responses, and each of those is
 * only internally sorted. Without re-sorting, the merged list would show
 * every failed row, then every quarantined row, with no interleaving by
 * recency inside the tail.
 *
 * Pure and total: rows with a null `updated_at` sort last within their
 * status group rather than throwing.
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
 * wrong (nemar-cli#808 / nemar-cli#827).
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
    signal: resolveSignal(init),
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
 * the first is authoritative for the chip counts.
 */
export async function listImportsByStatuses(
  statuses: readonly ImportStatus[],
  init: Init = {},
): Promise<ImportListResponse> {
  const responses = await Promise.all(statuses.map((status) => listAdminImports({ status }, init)));
  const imports = sortImportJobs(responses.flatMap((r) => r.imports));
  return {
    imports,
    total: imports.length,
    by_status: responses[0]?.by_status ?? {},
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
      signal: resolveSignal(init),
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
      signal: resolveSignal(init, VERIFY_TIMEOUT_MS),
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
 */
export interface ImportRollbackResult {
  readonly ok: boolean;
  readonly dataset_id: string;
  readonly rolled_back: boolean;
  readonly steps: readonly string[];
  readonly warnings: readonly string[];
}

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
      signal: resolveSignal(init, ROLLBACK_TIMEOUT_MS),
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
 */
export async function fetchImportsAttentionCount(init: Init = {}): Promise<number | null> {
  try {
    const { by_status } = await listAdminImports(
      { status: "quarantined" },
      { ...init, timeoutMs: init.timeoutMs ?? BADGE_TIMEOUT_MS },
    );
    return attentionCount(by_status);
  } catch {
    return null;
  }
}
