/**
 * Compute read client: `GET /compute/me`, `/compute/me/usage` and `/compute/me/jobs` (website ADR 0030
 * phase E2 addendum; nemar-cli `shared/contract/compute-user.ts`). All three answer for every access
 * state and with compute switched off, because they read the ledger and the job index.
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
import { COMPUTE_JOBS_PAGE_DEFAULT, COMPUTE_JOBS_PAGE_MAX } from "./compute-contract";
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

/** Reads `{ error: <sentence>, code: <word> }`, and the 403 `{ error, status, message }` shape. */
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
  throw new ComputeApiError(
    "shape",
    200,
    undefined,
    `The server's ${what} was not in the expected form.`,
  );
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

// --- Transport ------------------------------------------------------------------------------------

export interface ComputeInit {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** SSR: the visitor's `Cookie` header. Absent in the browser, which uses the `/api/v1` proxy. */
  readonly cookieHeader?: string;
  readonly timeoutMs?: number;
}

/** The URL of a read route, from the SSR base or the same-origin proxy. */
export function computeUrl(path: string, query: URLSearchParams, cookieHeader?: string): string {
  const qs = query.toString();
  return `${dashboardApiBase(cookieHeader)}/compute${path}${qs ? `?${qs}` : ""}`;
}

async function computeGet<T>(
  path: string,
  query: URLSearchParams,
  init: ComputeInit,
  parse: (body: unknown) => T,
): Promise<T> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  let res: Response;
  try {
    res = await fetchImpl(computeUrl(path, query, init.cookieHeader), {
      method: "GET",
      headers,
      credentials: "include",
      signal: resolveSignal(
        { signal: init.signal, timeoutMs: init.timeoutMs },
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
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
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ComputeApiError(
      "shape",
      res.status,
      undefined,
      "The server sent an answer this page could not read.",
    );
  }
  return parse(body);
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
