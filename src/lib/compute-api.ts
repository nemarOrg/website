/**
 * Compute client: the reads `GET /compute/me`, `/compute/me/usage` and `/compute/me/jobs` (website ADR
 * 0030 phase E2 addendum; nemar-cli `shared/contract/compute-user.ts`), which answer for every access
 * state and with compute switched off because they read the ledger and the job index; and, for the job
 * page (phase E3), `GET /compute/me/jobs/:id`, the log, the result links and their renewal, and the
 * cancel (nemar-cli `shared/contract/compute-responses.ts`, `compute-submit.ts`).
 *
 * Browser-safe: this module imports nothing from `./api-fetch.ts` (which pulls in a Node module the
 * browser bundle must not carry; `test/client-bundle-guard.test.ts`). SSR callers pass
 * `{ cookieHeader, fetch: apiFetch }`; browser callers pass nothing and go through the same-origin
 * `/api/v1` proxy, which forwards the session cookie.
 *
 * Three rules shape the parsers:
 *  - A body the guard rejects is a `shape` error, NEVER an empty list or zeros. The page then says the
 *    figures are missing, which is not the same as zero.
 *  - The guards are tolerant of extra keys and unknown words (the contract schemas are open) and strict
 *    about the type of every key the page reads. They copy out ONLY those keys, so a key the Worker adds
 *    later, or a pool it did not announce, cannot reach the markup by iteration. In particular only
 *    `pools.cpu` and `pools.gpu` are read, by name.
 *  - On these routes the sentence is in `error` and the machine word in `code`, the reverse of what
 *    `readError` in `./api-base.ts` assumes, so this client has its own error parser.
 */
import { dashboardApiBase } from "./api-base";
import {
  COMPUTE_JOBS_PAGE_DEFAULT,
  COMPUTE_JOBS_PAGE_MAX,
  COMPUTE_JOB_ID_RE,
  COMPUTE_TRUNCATED_HEADER,
} from "./compute-contract";
import { DEFAULT_REQUEST_TIMEOUT_MS, resolveSignal } from "./request-deadline";

// --- Errors ---------------------------------------------------------------------------------------

/**
 * What kind of failure it was, which decides what the page says:
 * `session` (401: sign in again), `account` (403: the account is not active; `sentence` is the
 * backend's message), `unavailable` (404, 5xx or `policy_unavailable`: the server cannot answer now),
 * `rejected` (another 4xx: the request was refused, with its `code`), `timeout`, `network`, and
 * `shape` (the answer was not the contract's).
 */
export type ComputeErrorKind =
  | "session"
  | "account"
  | "unavailable"
  | "rejected"
  | "timeout"
  | "network"
  | "shape";

export class ComputeApiError extends Error {
  constructor(
    readonly kind: ComputeErrorKind,
    readonly status: number,
    readonly code?: string,
    readonly sentence?: string,
  ) {
    super(sentence ?? `compute read failed: ${kind} (${status})`);
    this.name = "ComputeApiError";
  }
}

const TRANSPORT_WORD = /^[a-z][a-z0-9_]*$/;

interface ErrorBody {
  readonly code?: string;
  readonly sentence?: string;
}

/**
 * Reads `{ error: <sentence>, code: <word> }`, and the 403 `{ error, status, message }` shape. Neutral by
 * name and exported so the admin compute tab reads the same envelope with the same function.
 */
export async function readComputeError(res: Response): Promise<ErrorBody> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const { error, code, message } = body as Record<string, unknown>;
  const word = typeof code === "string" && TRANSPORT_WORD.test(code) ? code : undefined;
  // The 403 "Account not approved" shape carries the explanation in `message`.
  if (typeof message === "string" && message.trim().length > 0) {
    return { code: word, sentence: message };
  }
  if (typeof error === "string" && error.trim().length > 0) {
    // The proxy answers with a bare word (`upstream_unreachable`): that is a code, not a sentence.
    if (TRANSPORT_WORD.test(error)) return { code: word ?? error };
    return { code: word, sentence: error };
  }
  return { code: word };
}

function kindOf(status: number, code: string | undefined): ComputeErrorKind {
  if (status === 401) return "session";
  if (status === 403) return "account";
  if (status === 404 || status >= 500 || code === "policy_unavailable") return "unavailable";
  return "rejected";
}

// --- Shapes ---------------------------------------------------------------------------------------

export interface ComputePool {
  readonly granted_milli: number;
  readonly held_milli: number;
  readonly charged_milli: number;
  /** May be negative: an overrun, or a grant corrected below what is used. */
  readonly available_milli: number;
}

export interface ComputeAccess {
  /** A string: today one of six, but the page decides nothing the backend did not state. */
  readonly state: string;
  readonly requested_at: string | null;
  readonly granted_at: string | null;
  readonly terms_version: string | null;
  readonly current_terms_version: string;
  readonly terms_published: boolean;
  readonly requests_open?: boolean;
}

export interface ComputeQueueEstimate {
  readonly partition: string;
  readonly median_seconds: number | null;
  readonly p90_seconds: number | null;
  readonly count: number;
  readonly window_days: number;
}

export interface ComputeMe {
  readonly access: ComputeAccess;
  /** Exactly these two, by name. */
  readonly pools: { readonly cpu: ComputePool; readonly gpu: ComputePool };
  readonly frozen: boolean;
  /** The partitions offered to people, with the pool each draws on. */
  readonly partitions: readonly { readonly name: string; readonly pool: string }[];
  /**
   * How many days results are kept after a job ends (`limits.results_days`); null when the body does
   * not carry it. The job page derives its retention date from this until the server states one
   * (nemar-cli#2096).
   */
  readonly resultsDays: number | null;
  readonly queue: readonly ComputeQueueEstimate[];
}

export interface ComputeUsageRow {
  readonly day: string;
  readonly partition: string | null;
  readonly charged_milli: number;
  readonly jobs: number;
}

export interface ComputeUsage {
  readonly from: string;
  readonly to: string;
  readonly rows: readonly ComputeUsageRow[];
}

export interface ComputeJob {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly state: string;
  readonly app_id: string;
  readonly app_version: string;
  readonly partition: string;
  readonly pool: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly charged_milli: number;
  readonly failure_code: string | null;
  readonly cancel_requested: boolean;
}

export interface ComputeJobsPage {
  readonly jobs: readonly ComputeJob[];
  /** The cursor for the next page, opaque to the client; null on the last page. */
  readonly next_after: string | null;
}

// --- Guards ---------------------------------------------------------------------------------------

function shape(what: string): never {
  // The detail is for the log; the page shows the reason class, not this.
  throw new ComputeApiError("shape", 200, undefined, `unexpected ${what}`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) shape(what);
  return value as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string") shape(`${what} ${key}`);
  return v as string;
}

function nullableStr(o: Record<string, unknown>, key: string, what: string): string | null {
  const v = o[key];
  if (v === null) return null;
  if (typeof v !== "string") shape(`${what} ${key}`);
  return v as string;
}

function bool(o: Record<string, unknown>, key: string, what: string): boolean {
  const v = o[key];
  if (typeof v !== "boolean") shape(`${what} ${key}`);
  return v as boolean;
}

function integer(
  o: Record<string, unknown>,
  key: string,
  what: string,
  nonNegative = true,
): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || (nonNegative && v < 0)) {
    shape(`${what} ${key}`);
  }
  return v as number;
}

function nullableInteger(o: Record<string, unknown>, key: string, what: string): number | null {
  if (o[key] === null) return null;
  return integer(o, key, what);
}

function optionalPositiveInteger(
  o: Record<string, unknown>,
  key: string,
  what: string,
): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) shape(`${what} ${key}`);
  return v as number;
}

function array(o: Record<string, unknown>, key: string, what: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) shape(`${what} ${key}`);
  return v as unknown[];
}

function pool(value: unknown, which: string): ComputePool {
  const o = record(value, `${which} pool`);
  return {
    granted_milli: integer(o, "granted_milli", which),
    held_milli: integer(o, "held_milli", which),
    charged_milli: integer(o, "charged_milli", which),
    available_milli: integer(o, "available_milli", which, false),
  };
}

/** `GET /compute/me`, copied out key by key. */
export function parseComputeMe(body: unknown): ComputeMe {
  const root = record(body, "compute account");
  const access = record(root.access, "access");
  const pools = record(root.pools, "pools");
  const limits = record(root.limits, "limits");
  const requestsOpen = access.requests_open;
  if (requestsOpen !== undefined && typeof requestsOpen !== "boolean")
    shape("access requests_open");
  return {
    access: {
      state: str(access, "state", "access"),
      requested_at: nullableStr(access, "requested_at", "access"),
      granted_at: nullableStr(access, "granted_at", "access"),
      terms_version: nullableStr(access, "terms_version", "access"),
      current_terms_version: str(access, "current_terms_version", "access"),
      terms_published: bool(access, "terms_published", "access"),
      ...(requestsOpen === undefined ? {} : { requests_open: requestsOpen }),
    },
    // By name, never by iteration: a pool the Worker adds later is not this page's to draw.
    pools: { cpu: pool(pools.cpu, "cpu"), gpu: pool(pools.gpu, "gpu") },
    frozen: bool(root, "frozen", "account"),
    partitions: array(limits, "partitions", "limits").map((p) => {
      const o = record(p, "partition");
      return { name: str(o, "name", "partition"), pool: str(o, "pool", "partition") };
    }),
    resultsDays: optionalPositiveInteger(limits, "results_days", "limits"),
    queue: array(root, "queue", "account").map((q) => {
      const o = record(q, "queue estimate");
      return {
        partition: str(o, "partition", "queue"),
        median_seconds: nullableInteger(o, "median_seconds", "queue"),
        p90_seconds: nullableInteger(o, "p90_seconds", "queue"),
        count: integer(o, "count", "queue"),
        window_days: integer(o, "window_days", "queue"),
      };
    }),
  };
}

/** `GET /compute/me/usage?group=day,partition`, copied out key by key. */
export function parseComputeUsage(body: unknown): ComputeUsage {
  const root = record(body, "usage");
  const group = array(root, "group", "usage");
  if (!group.includes("day") || !group.includes("partition")) shape("usage grouping");
  return {
    from: str(root, "from", "usage"),
    to: str(root, "to", "usage"),
    rows: array(root, "rows", "usage").map((r) => {
      const o = record(r, "usage row");
      return {
        day: str(o, "day", "usage row"),
        partition: nullableStr(o, "partition", "usage row"),
        charged_milli: integer(o, "charged_milli", "usage row", false),
        jobs: integer(o, "jobs", "usage row"),
      };
    }),
  };
}

function job(value: unknown): ComputeJob {
  const o = record(value, "job");
  return {
    id: str(o, "id", "job"),
    kind: str(o, "kind", "job"),
    source: str(o, "source", "job"),
    state: str(o, "state", "job"),
    app_id: str(o, "app_id", "job"),
    app_version: str(o, "app_version", "job"),
    partition: str(o, "partition", "job"),
    pool: str(o, "pool", "job"),
    created_at: str(o, "created_at", "job"),
    started_at: nullableStr(o, "started_at", "job"),
    ended_at: nullableStr(o, "ended_at", "job"),
    charged_milli: integer(o, "charged_milli", "job"),
    failure_code: nullableStr(o, "failure_code", "job"),
    cancel_requested: bool(o, "cancel_requested", "job"),
  };
}

/** `GET /compute/me/jobs`. `next_after` must be present: its absence is a shape error, not "last page". */
export function parseComputeJobs(body: unknown): ComputeJobsPage {
  const root = record(body, "job list");
  if (!("next_after" in root)) shape("job list next_after");
  return {
    jobs: array(root, "jobs", "job list").map(job),
    next_after: nullableStr(root, "next_after", "job list"),
  };
}

// --- The job page (phase E3) ----------------------------------------------------------------------

export interface ComputeJobResources {
  readonly nodes: number;
  readonly cores_per_node: number;
  /** Null when the job asked for no memory figure. */
  readonly memory_mb: number | null;
  readonly gpus: number;
  readonly minutes: number;
}

/** One job as `GET /compute/me/jobs/:id` serves it: the list row plus its resources. */
export interface ComputeJobDetail extends ComputeJob {
  readonly resources: ComputeJobResources;
  /**
   * A name the job was given. The user view carries none today (nemar-cli#2079); the guard reads an
   * optional string so the page needs no change the day it appears.
   */
  readonly name: string | null;
}

/** `GET /compute/me/jobs/:id`: the job, and whether the cluster read behind it failed. */
export interface ComputeJobRead {
  readonly job: ComputeJobDetail;
  /** True when the refresh from the cluster failed and the stored record is shown. */
  readonly stale: boolean;
}

/** `GET /compute/me/jobs/:id`, copied out key by key. */
export function parseComputeJob(body: unknown): ComputeJobRead {
  const root = record(body, "job answer");
  const row = record(root.job, "job");
  const res = record(row.resources, "job resources");
  const stale = root.stale;
  if (stale !== undefined && typeof stale !== "boolean") shape("job answer stale");
  const name = row.name;
  if (name !== undefined && name !== null && typeof name !== "string") shape("job name");
  return {
    job: {
      ...job(row),
      resources: {
        nodes: integer(res, "nodes", "job resources"),
        cores_per_node: integer(res, "cores_per_node", "job resources"),
        memory_mb: nullableInteger(res, "memory_mb", "job resources"),
        gpus: integer(res, "gpus", "job resources"),
        minutes: integer(res, "minutes", "job resources"),
      },
      name: typeof name === "string" && name.length > 0 ? name : null,
    },
    stale: stale === true,
  };
}

export interface ComputeResultFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** A BEARER link: whoever holds it can download until `expires_at`. Never stored, logged or copied. */
  readonly url: string;
}

/** `GET|POST /compute/jobs/:id/results[/renew]`: seven-day links to a finished job's outputs. */
export interface ComputeResults {
  readonly expires_at: string;
  readonly files: readonly ComputeResultFile[];
  /** How many outputs the job has in all. */
  readonly total: number;
  readonly truncated: boolean;
  /** The cursor for the next page, opaque to the client; null on the last page. */
  readonly next_after: string | null;
  /** The backend's own sentence about the links, shown as served. */
  readonly notice: string;
}

/** The results answer, copied out key by key. `bearer_links` must be `true`: anything else is not this contract. */
export function parseComputeResults(body: unknown): ComputeResults {
  const root = record(body, "results");
  if (root.bearer_links !== true) shape("results bearer_links");
  if (!("next_after" in root)) shape("results next_after");
  return {
    expires_at: str(root, "expires_at", "results"),
    files: array(root, "files", "results").map((f) => {
      const o = record(f, "result file");
      return {
        path: str(o, "path", "result file"),
        size: integer(o, "size", "result file"),
        sha256: str(o, "sha256", "result file"),
        url: str(o, "url", "result file"),
      };
    }),
    total: integer(root, "total", "results"),
    truncated: bool(root, "truncated", "results"),
    next_after: nullableStr(root, "next_after", "results"),
    notice: str(root, "notice", "results"),
  };
}

/** `POST /compute/jobs/:id/cancel`. */
export interface ComputeCancel {
  /** The job's state after the call; a cancel at the cluster is carried out afterwards. */
  readonly state: string | null;
  /** One of `COMPUTE_CANCEL_OUTCOMES` today; the field is open. */
  readonly outcome: string;
  /** False when the job had already ended another way; absent from an older Worker. */
  readonly cancelled: boolean | null;
}

export function parseComputeCancel(body: unknown): ComputeCancel {
  const root = record(body, "cancel answer");
  if (root.ok !== true) shape("cancel answer ok");
  const cancelled = root.cancelled;
  if (cancelled !== undefined && typeof cancelled !== "boolean") shape("cancel answer cancelled");
  return {
    state: nullableStr(root, "state", "cancel answer"),
    outcome: str(root, "outcome", "cancel answer"),
    cancelled: typeof cancelled === "boolean" ? cancelled : null,
  };
}

/** A job's log: the first 1 MiB of its text, and whether there is more after it. */
export interface ComputeLog {
  readonly text: string;
  readonly truncated: boolean;
}

/** Whether an error is the backend's one answer for an absent, foreign or malformed job. */
export function isJobNotFound(err: unknown): boolean {
  return err instanceof ComputeApiError && err.code === "job_not_found";
}

// --- Transport ------------------------------------------------------------------------------------

export interface ComputeInit {
  readonly signal?: AbortSignal;
  /** `fetch`, or `apiFetch` on the server (it takes a string or a URL). */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** SSR: the visitor's `Cookie` header. Absent in the browser, which uses the `/api/v1` proxy. */
  readonly cookieHeader?: string;
  readonly timeoutMs?: number;
}

/** The URL of a read route, from the SSR base or the same-origin proxy. */
export function computeUrl(path: string, query: URLSearchParams, cookieHeader?: string): string {
  const qs = query.toString();
  return `${dashboardApiBase(cookieHeader)}/compute${path}${qs ? `?${qs}` : ""}`;
}

/** One request, mapped to a `ComputeApiError` on a transport failure or a refusal; the caller reads the body. */
async function computeRequest(
  method: "GET" | "POST",
  path: string,
  query: URLSearchParams,
  init: ComputeInit,
  accept: string,
  defaultTimeoutMs: number,
): Promise<Response> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: accept };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  let res: Response;
  try {
    res = await fetchImpl(computeUrl(path, query, init.cookieHeader), {
      method,
      headers,
      credentials: "include",
      signal: resolveSignal({ signal: init.signal, timeoutMs: init.timeoutMs }, defaultTimeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ComputeApiError("timeout", 0);
    }
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ComputeApiError("network", 0);
  }
  if (!res.ok) {
    const { code, sentence } = await readComputeError(res);
    throw new ComputeApiError(kindOf(res.status, code), res.status, code, sentence);
  }
  return res;
}

async function computeGet<T>(
  path: string,
  query: URLSearchParams,
  init: ComputeInit,
  parse: (body: unknown) => T,
  defaultTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return readJson(
    await computeRequest("GET", path, query, init, "application/json", defaultTimeoutMs),
    parse,
  );
}

async function readJson<T>(res: Response, parse: (body: unknown) => T): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ComputeApiError("shape", res.status, undefined, "unreadable body");
  }
  return parse(body);
}

/**
 * A write: no body, no key, no retry. A cookie session passes the backend's origin guard because the
 * browser sends `Origin` and the same-origin proxy forwards it; a repeat of a lost answer is the
 * caller's decision (the page re-reads the job first).
 */
async function computePost<T>(
  path: string,
  query: URLSearchParams,
  init: ComputeInit,
  parse: (body: unknown) => T,
  defaultTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return readJson(
    await computeRequest("POST", path, query, init, "application/json", defaultTimeoutMs),
    parse,
  );
}

/** The caller's access, balances, partitions and queue estimates. Answers in every access state. */
export function getComputeMe(init: ComputeInit = {}): Promise<ComputeMe> {
  return computeGet("/me", new URLSearchParams(), init, parseComputeMe);
}

/**
 * The net charge by UTC day and partition. No `from`/`to`: the server's default window (the 30 days
 * ending today, UTC) is authoritative, and the chart's axis comes from the answer's own `from` and `to`.
 */
export function getComputeUsage(init: ComputeInit = {}): Promise<ComputeUsage> {
  return computeGet(
    "/me/usage",
    new URLSearchParams({ group: "day,partition" }),
    init,
    parseComputeUsage,
  );
}

export interface ListComputeJobsInput {
  /** The opaque `next_after` of the previous page. Passed back unchanged, URL-encoded by the query. */
  readonly after?: string | null;
  readonly limit?: number;
}

/** One page of the caller's jobs, newest first, from every front door. */
export function listComputeJobs(
  input: ListComputeJobsInput = {},
  init: ComputeInit = {},
): Promise<ComputeJobsPage> {
  const limit = input.limit ?? COMPUTE_JOBS_PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > COMPUTE_JOBS_PAGE_MAX) {
    throw new RangeError("limit is a whole number from 1 to 100");
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (input.after) query.set("after", input.after);
  return computeGet("/me/jobs", query, init, parseComputeJobs);
}

// --- The job page's calls -------------------------------------------------------------------------

/** The longest the log read waits: the backend may read the cluster for several seconds first. */
export const COMPUTE_LOG_TIMEOUT_MS = 30_000;

/**
 * The longest a job read waits. A live job older than a minute is read back from the cluster first
 * (the backend's read is bounded at about 8 s), so the 5 s default would turn a slow cluster into a
 * false error instead of the stored record with `stale: true`.
 */
export const COMPUTE_JOB_READ_TIMEOUT_MS = 12_000;

/**
 * The longest a cancel waits. The backend carries the cancel out at the cluster and reads the job back
 * before it answers, so a slow cluster must still end in the cancel's own outcome, not in a timeout the
 * page reads as "could not tell".
 */
export const COMPUTE_CANCEL_TIMEOUT_MS = 20_000;

function jobPath(id: string, rest: string): string {
  // The id goes into a URL path: nothing that is not a job id may.
  if (!COMPUTE_JOB_ID_RE.test(id))
    throw new RangeError("a job id is job_ and 24 lowercase hex digits");
  return `/${rest.replace(":id", id)}`;
}

/** One of the caller's jobs; `stale` says the cluster could not be asked and the stored record is shown. */
export function getComputeJob(id: string, init: ComputeInit = {}): Promise<ComputeJobRead> {
  return computeGet(
    jobPath(id, "me/jobs/:id"),
    new URLSearchParams(),
    init,
    parseComputeJob,
    COMPUTE_JOB_READ_TIMEOUT_MS,
  );
}

/**
 * The job's log as text (the FIRST 1 MiB; `truncated` says more follows). Never JSON: the body is the
 * job's own bytes and is read with `text()`, which turns invalid UTF-8 into U+FFFD.
 */
export async function getComputeLogs(id: string, init: ComputeInit = {}): Promise<ComputeLog> {
  const res = await computeRequest(
    "GET",
    jobPath(id, "jobs/:id/logs"),
    new URLSearchParams(),
    init,
    "text/plain",
    COMPUTE_LOG_TIMEOUT_MS,
  );
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ComputeApiError("network", res.status);
  }
  return { text, truncated: res.headers.get(COMPUTE_TRUNCATED_HEADER) === "true" };
}

function afterQuery(after: string | null | undefined): URLSearchParams {
  const query = new URLSearchParams();
  if (after) query.set("after", after);
  return query;
}

/** New seven-day links for a finished job's outputs, from `after` (the previous `next_after`) on. MINTS links. */
export function getComputeResults(
  id: string,
  after: string | null = null,
  init: ComputeInit = {},
): Promise<ComputeResults> {
  return computeGet(jobPath(id, "jobs/:id/results"), afterQuery(after), init, parseComputeResults);
}

/** The same handler as {@link getComputeResults} over POST; MINTS links. */
export function renewComputeResults(
  id: string,
  after: string | null = null,
  init: ComputeInit = {},
): Promise<ComputeResults> {
  return computePost(
    jobPath(id, "jobs/:id/results/renew"),
    afterQuery(after),
    init,
    parseComputeResults,
  );
}

/** Ask for the job to be stopped. No body, no key; an ended job answers 200 with `cancelled: false`. */
export function cancelComputeJob(id: string, init: ComputeInit = {}): Promise<ComputeCancel> {
  return computePost(
    jobPath(id, "jobs/:id/cancel"),
    new URLSearchParams(),
    init,
    parseComputeCancel,
    COMPUTE_CANCEL_TIMEOUT_MS,
  );
}
