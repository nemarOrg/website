/**
 * Admin Compute client: the routes under `/admin/compute/*` (nemar-cli epic #2021, phase D1 and
 * Epic A's reporting routes), for the admin Compute tab (website ADR 0030; epic
 * nemarOrg/website#493 phase E4, issue #497).
 *
 * Browser-safe, like `mail-admin-api.ts`: plain `fetch`, never `api-fetch.ts` (the client bundle
 * guard forbids it). SSR callers pass `cookieHeader` and hit the API directly; browser callers
 * omit it and go through the same-origin `/api/v1` proxy, which forwards `Origin` (the API checks
 * `Origin` on cookie-authenticated admin writes).
 *
 * ERRORS. These routes answer `{ error: <sentence>, code: <word> }`, the reverse of the Users
 * routes, where `readError()` in `api-base.ts` reads `error` as the code. So this client has its
 * own reader, {@link readComputeAdminError}. Other things also arrive here and are told apart:
 * the plain admin gate (`{ error: "Admin access required" }`, no `code`), the proxy's own
 * `upstream_unreachable` and `upstream_redirect` words, and a gateway page that is not JSON.
 *
 * SHAPES. Hand-written guards (this repo has no zod): a body a guard rejects raises a
 * {@link ComputeAdminApiError}, never an empty list, so a section shows a failure and not
 * "nothing". An unknown extra key is tolerated and a word this build does not know is a string.
 *
 * DECISIONS are the one call that must never run twice on its own. {@link decideComputeAccess}
 * posts once; {@link classifyDecisionFailure} says what a caller may do after a failure. Nothing
 * here retries a POST.
 */

import { dashboardApiBase } from "./api-base";
import {
  COMPUTE_ACCESS_DECISIONS,
  COMPUTE_ACCESS_LISTED_STATES,
  COMPUTE_ACCESS_PAGE_MAX,
  COMPUTE_ACCESS_REASON_MAX_CHARS,
  COMPUTE_JOB_FLAGS,
  COMPUTE_POOLS_PAGE_MAX,
  COMPUTE_POOL_HOLDER_KINDS,
  COMPUTE_REPORT_PAGE_MAX,
  COMPUTE_STATES,
  type ComputeAccessAdminErrorCode,
  type ComputeAccessDecision,
  type ComputeAccessListedState,
  type ComputeJobFlag,
  type ComputePoolHolderKind,
} from "./compute-admin-contract";
import { resolveSignal } from "./request-deadline";

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  /** Abort the request after this many ms. Defaults to the shared 5 s deadline. */
  readonly timeoutMs?: number;
};

/** The badge sits on every admin page, so it gets less than a page read. */
const BADGE_TIMEOUT_MS = 2000;
/** The status route mints one Tapis token and makes one health call; give it longer than a D1 read. */
const STATUS_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A refusal or failure from a compute admin route, or from the proxy in front of it. */
export class ComputeAdminApiError extends Error {
  readonly status: number;
  /** The word the API sent in `code`, whatever it is; `undefined` when it sent none. */
  readonly code?: string;
  /** The body's `error` text: a sentence from the API, or a word from the proxy. */
  readonly sentence?: string;
  constructor(status: number, code?: string, sentence?: string) {
    super(sentence ?? code ?? `Compute request failed (${status})`);
    this.name = "ComputeAdminApiError";
    this.status = status;
    this.code = code;
    this.sentence = sentence;
  }
}

/** The sentence used for a 2xx whose body is not what the page expects. */
export const MALFORMED_SENTENCE = "The server sent an answer this page could not read.";

/**
 * What a non-OK response says, whatever shape it has. Never throws: a body that is not JSON (a
 * gateway page, maintenance mode) yields `{}` and the caller falls back on the status.
 */
export async function readComputeAdminError(
  res: Response,
): Promise<{ code?: string; sentence?: string }> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {};
  }
  if (!body || typeof body !== "object") return {};
  const { error, code } = body as Record<string, unknown>;
  return {
    code: typeof code === "string" && code.length > 0 ? code : undefined,
    sentence: typeof error === "string" && error.length > 0 ? error : undefined,
  };
}

/**
 * One line for a person, from whatever a compute call threw: the API's own sentence when it sent
 * one (the backend's words are the page's words), else the proxy's word in the site's voice, else
 * the transport failure.
 */
export function computeAdminErrorText(err: unknown): string {
  if (err instanceof ComputeAdminApiError) {
    const word = err.sentence;
    if (word === "upstream_unreachable") {
      return "The server could not be reached. Check your connection and try again.";
    }
    if (word === "upstream_redirect") {
      return "The server answered in a way this page cannot follow. Try again later.";
    }
    if (word === "origin_not_allowed") {
      return "This page was not accepted as the source of the request. Reload and try again.";
    }
    if (word) return word;
    if (err.status === 401) return "You are signed out. Sign in again.";
    if (err.status === 429) return "Too many requests. Wait a moment, then try again.";
    return `The request failed (${err.status}). Try again.`;
  }
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "The server did not answer in time. Try again.";
  }
  if (err instanceof TypeError) {
    return "The server could not be reached. Check your connection and try again.";
  }
  return err instanceof Error && err.message ? err.message : "Something went wrong. Try again.";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function computeFetch<T>(
  method: "GET" | "POST",
  path: string,
  init: Init,
  parse: (body: unknown) => T,
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(`${dashboardApiBase(init.cookieHeader)}/admin/compute${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "include",
    signal: resolveSignal({ signal: init.signal, timeoutMs: init.timeoutMs ?? options.timeoutMs }),
  });
  if (!res.ok) {
    const { code, sentence } = await readComputeAdminError(res);
    throw new ComputeAdminApiError(res.status, code, sentence);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // The call succeeded and its answer is unreadable. Say so with the real status, so a
    // caller that cannot tell what happened (a decision) treats it as unknown.
    throw new ComputeAdminApiError(res.status, undefined, MALFORMED_SENTENCE);
  }
  try {
    return parse(body);
  } catch (err) {
    if (err instanceof ComputeAdminApiError) throw err;
    throw new ComputeAdminApiError(res.status, undefined, MALFORMED_SENTENCE);
  }
}

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
function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return int(value);
}

// --- Access ---------------------------------------------------------------------------------------

/** One account in the administrator's listing, as the Worker reports it. */
export interface ComputeAccessRow {
  readonly id: number;
  readonly username: string | null;
  readonly email: string;
  readonly given_name: string | null;
  readonly family_name: string | null;
  readonly affiliation: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly orcid: string | null;
  readonly account_kind: string | null;
  /** The state word. A word this build does not know is kept as is. */
  readonly compute_access: string;
  readonly compute_access_requested_at: string | null;
  readonly compute_access_notified_at: string | null;
  readonly compute_access_granted_at: string | null;
  readonly compute_access_granted_by: number | null;
  readonly compute_purpose: string | null;
  readonly compute_terms_version: string | null;
  readonly compute_terms_accepted_at: string | null;
}

export function parseAccessRow(value: unknown): ComputeAccessRow {
  const o = dict(value);
  return {
    id: int(o.id),
    username: strOrNull(o.username),
    email: str(o.email),
    given_name: strOrNull(o.given_name),
    family_name: strOrNull(o.family_name),
    affiliation: strOrNull(o.affiliation),
    city: strOrNull(o.city),
    country: strOrNull(o.country),
    orcid: strOrNull(o.orcid),
    account_kind: strOrNull(o.account_kind),
    compute_access: str(o.compute_access),
    compute_access_requested_at: strOrNull(o.compute_access_requested_at),
    compute_access_notified_at: strOrNull(o.compute_access_notified_at),
    compute_access_granted_at: strOrNull(o.compute_access_granted_at),
    compute_access_granted_by: intOrNull(o.compute_access_granted_by),
    compute_purpose: strOrNull(o.compute_purpose),
    compute_terms_version: strOrNull(o.compute_terms_version),
    compute_terms_accepted_at: strOrNull(o.compute_terms_accepted_at),
  };
}

export interface ComputeAccessPage {
  readonly accounts: readonly ComputeAccessRow[];
  /** The id after which the next page starts; null on the last page. */
  readonly next_after: number | null;
}

export function parseAccessPage(value: unknown): ComputeAccessPage {
  const o = dict(value);
  return {
    accounts: arr(o.accounts).map(parseAccessRow),
    next_after: intOrNull(o.next_after),
  };
}

/** What a grant did to the person's allocation. `reason` is a fixed word the Worker may grow. */
export interface ComputeAllocation {
  readonly granted: boolean;
  readonly cpu_milli: number;
  readonly gpu_milli: number;
  readonly reason: string | null;
  readonly policy_version: number | null;
}

export interface ComputeDecisionResult {
  readonly decision: string;
  readonly from: string;
  readonly to: string;
  readonly account: ComputeAccessRow;
  /** Only a grant carries one. */
  readonly allocation: ComputeAllocation | null;
  /** Whether the person's mail was delivered. Absent reads as unknown: false is the only "no". */
  readonly email_sent: boolean | null;
}

export function parseDecisionResult(value: unknown): ComputeDecisionResult {
  const o = dict(value);
  let allocation: ComputeAllocation | null = null;
  if (o.allocation !== undefined && o.allocation !== null) {
    const a = dict(o.allocation);
    allocation = {
      granted: bool(a.granted),
      cpu_milli: int(a.cpu_milli),
      gpu_milli: int(a.gpu_milli),
      reason: strOrNull(a.reason),
      policy_version: intOrNull(a.policy_version),
    };
  }
  return {
    decision: str(o.decision),
    from: str(o.from),
    to: str(o.to),
    account: parseAccessRow(o.account),
    allocation,
    email_sent: o.email_sent === undefined || o.email_sent === null ? null : bool(o.email_sent),
  };
}

// --- Pools ------------------------------------------------------------------------------------------

export interface ComputePoolRow {
  readonly id: number;
  readonly holder_kind: string;
  readonly holder_ref: string;
  readonly pool: string;
  readonly granted_milli: number;
  readonly held_milli: number;
  readonly charged_milli: number;
  /** granted - held - charged as the Worker computed it; may be negative. */
  readonly available_milli: number;
  readonly frozen: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export function parsePoolRow(value: unknown): ComputePoolRow {
  const o = dict(value);
  return {
    id: int(o.id),
    holder_kind: str(o.holder_kind),
    holder_ref: str(o.holder_ref),
    pool: str(o.pool),
    granted_milli: int(o.granted_milli),
    held_milli: int(o.held_milli),
    charged_milli: int(o.charged_milli),
    available_milli: int(o.available_milli),
    frozen: bool(o.frozen),
    created_at: str(o.created_at),
    updated_at: str(o.updated_at),
  };
}

export interface ComputePoolsPage {
  readonly pools: readonly ComputePoolRow[];
  readonly next_after: number | null;
}

export function parsePoolsPage(value: unknown): ComputePoolsPage {
  const o = dict(value);
  return { pools: arr(o.pools).map(parsePoolRow), next_after: intOrNull(o.next_after) };
}

// --- Jobs -----------------------------------------------------------------------------------------

/** A job as an administrator sees it: fixed words, numbers and times. No identity, no log. */
export interface ComputeJobRow {
  readonly id: string;
  readonly account_id: number | null;
  readonly source: string;
  readonly kind: string;
  readonly state: string;
  readonly failure_code: string | null;
  readonly failure_detail: string | null;
  readonly platform_failure: boolean;
  readonly partition: string;
  readonly pool: string;
  readonly held_milli: number;
  readonly charged_milli: number;
  readonly flags: readonly string[];
  readonly created_at: string;
  readonly ended_at: string | null;
  readonly partner_state: string | null;
  readonly partner_flag: string | null;
}

export function parseJobRow(value: unknown): ComputeJobRow {
  const o = dict(value);
  return {
    id: str(o.id),
    account_id: intOrNull(o.account_id),
    source: str(o.source),
    kind: str(o.kind),
    state: str(o.state),
    failure_code: strOrNull(o.failure_code),
    failure_detail: strOrNull(o.failure_detail),
    platform_failure: bool(o.platform_failure),
    partition: str(o.partition),
    pool: str(o.pool),
    held_milli: int(o.held_milli),
    charged_milli: int(o.charged_milli),
    flags: arr(o.flags).map(str),
    created_at: str(o.created_at),
    ended_at: strOrNull(o.ended_at),
    partner_state: strOrNull(o.partner_state),
    partner_flag: strOrNull(o.partner_flag),
  };
}

export interface ComputeJobsPage {
  readonly jobs: readonly ComputeJobRow[];
  /** A row sequence, not a job id; pass it back as `after`. */
  readonly next_after: number | null;
}

export function parseJobsPage(value: unknown): ComputeJobsPage {
  const o = dict(value);
  return { jobs: arr(o.jobs).map(parseJobRow), next_after: intOrNull(o.next_after) };
}

/** The scheduler's own accounting row that no NEMAR job claims. */
export interface ComputeUnmatchedRow {
  readonly slurm_job_id: string;
  readonly partition: string;
  readonly state: string;
  readonly elapsed_seconds: number;
  readonly alloc_nodes: number;
  readonly alloc_cpus: number;
  readonly alloc_gpus: number;
  /** milli-SU, or null when the row could not be priced. */
  readonly charged_milli: number | null;
  readonly ingested_at: string;
}

export interface ComputeUnmatchedPage {
  readonly rows: readonly ComputeUnmatchedRow[];
  readonly total: number;
}

export function parseUnmatchedPage(value: unknown): ComputeUnmatchedPage {
  const o = dict(value);
  return {
    rows: arr(o.rows).map((raw) => {
      const r = dict(raw);
      return {
        slurm_job_id: str(r.slurm_job_id),
        partition: str(r.partition),
        state: str(r.state),
        elapsed_seconds: int(r.elapsed_seconds),
        alloc_nodes: int(r.alloc_nodes),
        alloc_cpus: int(r.alloc_cpus),
        alloc_gpus: int(r.alloc_gpus),
        charged_milli: intOrNull(r.charged_milli),
        ingested_at: str(r.ingested_at),
      };
    }),
    total: int(o.total),
  };
}

// --- Access report and status -----------------------------------------------------------------------

export interface ComputeAccessReport {
  readonly quarter: string;
  readonly rows: ReadonlyArray<{
    readonly partition: string;
    readonly source: string;
    readonly distinct_users: number;
    readonly jobs: number;
  }>;
  readonly totals: { readonly distinct_users: number; readonly jobs: number };
}

export function parseAccessReport(value: unknown): ComputeAccessReport {
  const o = dict(value);
  const totals = dict(o.totals);
  return {
    quarter: str(o.quarter),
    rows: arr(o.rows).map((raw) => {
      const r = dict(raw);
      return {
        partition: str(r.partition),
        source: str(r.source),
        distinct_users: int(r.distinct_users),
        jobs: int(r.jobs),
      };
    }),
    totals: { distinct_users: int(totals.distinct_users), jobs: int(totals.jobs) },
  };
}

/** The slice of `GET /admin/compute/status` the Reconciliation view reads. */
export interface ComputeStatus {
  readonly compute_enabled: boolean;
  /** Null when this Worker does not say (an older one). Unknown is never rendered as "not paused". */
  readonly reconciliation_paused: boolean | null;
  /** Counts by fixed word. A value that is not a count stays as `unknown`, never zero. */
  readonly attention: Readonly<Record<string, unknown>>;
  readonly tapis_token: string;
  readonly tapis_health: string;
}

export function parseStatus(value: unknown): ComputeStatus {
  const o = dict(value);
  const switches = dict(o.switches);
  const tapis = dict(o.tapis);
  let paused: boolean | null = null;
  if (o.reconciliation !== undefined && o.reconciliation !== null) {
    paused = bool(dict(o.reconciliation).paused);
  }
  let attention: Record<string, unknown> = {};
  if (o.attention !== undefined && o.attention !== null) attention = { ...dict(o.attention) };
  return {
    compute_enabled: bool(switches.compute_enabled),
    reconciliation_paused: paused,
    attention,
    tapis_token: str(tapis.token),
    tapis_health: str(tapis.health),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

function clampLimit(value: unknown, max: number): number | undefined {
  const n = positiveInt(value);
  return n === undefined ? undefined : Math.min(n, max);
}

function withQuery(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface AccessQueryInput {
  state?: string | null;
  after?: number | string | null;
  limit?: number | string | null;
}

/** The access listing's query: anything the route would refuse is dropped, not sent. */
export function computeAccessQuery(input: AccessQueryInput): string {
  const params = new URLSearchParams();
  const state = input.state ?? "";
  if ((COMPUTE_ACCESS_LISTED_STATES as readonly string[]).includes(state)) {
    params.set("state", state);
  }
  const after = positiveInt(input.after);
  if (after !== undefined) params.set("after", String(after));
  const limit = clampLimit(input.limit, COMPUTE_ACCESS_PAGE_MAX);
  if (limit !== undefined) params.set("limit", String(limit));
  return withQuery(params);
}

export function listComputeAccess(
  input: AccessQueryInput = {},
  init: Init = {},
): Promise<ComputeAccessPage> {
  return computeFetch("GET", `/access${computeAccessQuery(input)}`, init, parseAccessPage);
}

/**
 * One account, read again after an outcome that could not be told. There is no single-account
 * route (nemar-cli#2088), so this uses the listing's documented keyset (`id > after`, every
 * listed state): `after = id - 1`, `limit = 1`. The row is returned only when it is the one
 * asked for; an account that is not listed (never asked, or deleted) reads as `null`.
 */
export async function getComputeAccount(
  id: number,
  init: Init = {},
): Promise<ComputeAccessRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const query = id > 1 ? `?after=${id - 1}&limit=1` : "?limit=1";
  const page = await computeFetch("GET", `/access${query}`, init, parseAccessPage);
  return page.accounts.find((a) => a.id === id) ?? null;
}

export interface PoolsQueryInput {
  holderKind?: string | null;
  after?: number | string | null;
  limit?: number | string | null;
}

export function computePoolsQuery(input: PoolsQueryInput): string {
  const params = new URLSearchParams();
  const kind = input.holderKind ?? "";
  if ((COMPUTE_POOL_HOLDER_KINDS as readonly string[]).includes(kind)) {
    params.set("holder_kind", kind);
  }
  const after = positiveInt(input.after);
  if (after !== undefined) params.set("after", String(after));
  const limit = clampLimit(input.limit, COMPUTE_POOLS_PAGE_MAX);
  if (limit !== undefined) params.set("limit", String(limit));
  return withQuery(params);
}

export function listComputePools(
  input: PoolsQueryInput = {},
  init: Init = {},
): Promise<ComputePoolsPage> {
  return computeFetch("GET", `/pools${computePoolsQuery(input)}`, init, parsePoolsPage);
}

export interface JobsQueryInput {
  flag?: string | null;
  state?: string | null;
  account?: number | string | null;
  after?: number | string | null;
  limit?: number | string | null;
}

export function computeJobsQuery(input: JobsQueryInput): string {
  const params = new URLSearchParams();
  const flag = input.flag ?? "";
  if ((COMPUTE_JOB_FLAGS as readonly string[]).includes(flag)) params.set("flag", flag);
  const state = input.state ?? "";
  if ((COMPUTE_STATES as readonly string[]).includes(state)) params.set("state", state);
  const account = positiveInt(input.account);
  if (account !== undefined) params.set("account", String(account));
  const after = positiveInt(input.after);
  if (after !== undefined) params.set("after", String(after));
  const limit = clampLimit(input.limit, COMPUTE_REPORT_PAGE_MAX);
  if (limit !== undefined) params.set("limit", String(limit));
  return withQuery(params);
}

export function listComputeJobs(
  input: JobsQueryInput = {},
  init: Init = {},
): Promise<ComputeJobsPage> {
  return computeFetch("GET", `/jobs${computeJobsQuery(input)}`, init, parseJobsPage);
}

/** The scheduler's accounting rows that no job claims: newest first, `limit` only (no cursor). */
export function listUnmatchedAccounting(
  limit: number | string | null = null,
  init: Init = {},
): Promise<ComputeUnmatchedPage> {
  const params = new URLSearchParams({ unmatched: "1" });
  const n = clampLimit(limit, COMPUTE_REPORT_PAGE_MAX);
  if (n !== undefined) params.set("limit", String(n));
  return computeFetch("GET", `/jobs${withQuery(params)}`, init, parseUnmatchedPage);
}

/** A quarter as the route spells it: `2026Q4`. */
export const QUARTER_PATTERN = /^\d{4}Q[1-4]$/;

export function getComputeAccessReport(
  quarter: string,
  init: Init = {},
): Promise<ComputeAccessReport> {
  if (!QUARTER_PATTERN.test(quarter)) {
    return Promise.reject(
      new ComputeAdminApiError(400, "invalid_query", "A quarter is written like 2026Q4."),
    );
  }
  return computeFetch(
    "GET",
    `/access-report?quarter=${encodeURIComponent(quarter)}`,
    init,
    parseAccessReport,
  );
}

export function getComputeStatus(init: Init = {}): Promise<ComputeStatus> {
  return computeFetch("GET", "/status", init, parseStatus, { timeoutMs: STATUS_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Post one decision for one account by id (a web account has no username). The body is `{}` or
 * `{ reason }` with the reason trimmed and omitted when empty, as the route trims it. Posts once:
 * the state flip is guarded by the from-state, so a repeat changes nothing, but this client never
 * repeats a POST on its own. A reason over the bound is refused here with the route's own word
 * (`invalid_body`) and sends nothing.
 */
export function decideComputeAccess(
  id: number,
  decision: ComputeAccessDecision,
  reason: string | undefined,
  init: Init = {},
): Promise<ComputeDecisionResult> {
  if (!Number.isSafeInteger(id) || id < 1) {
    return Promise.reject(
      new ComputeAdminApiError(400, "invalid_query", "That is not an account id."),
    );
  }
  if (!(COMPUTE_ACCESS_DECISIONS as readonly string[]).includes(decision)) {
    return Promise.reject(new ComputeAdminApiError(400, "invalid_body", "That is not a decision."));
  }
  const trimmed = (reason ?? "").trim();
  if (trimmed.length > COMPUTE_ACCESS_REASON_MAX_CHARS) {
    return Promise.reject(
      new ComputeAdminApiError(
        400,
        "invalid_body",
        `A reason is at most ${COMPUTE_ACCESS_REASON_MAX_CHARS} characters.`,
      ),
    );
  }
  const body = trimmed ? { reason: trimmed } : {};
  return computeFetch("POST", `/access/${decision}/by-id/${id}`, init, parseDecisionResult, {
    body,
  });
}

/**
 * What a caller may do after a decision call failed.
 *
 * - `refused`: a definite refusal; nothing changed and the row is as it was. 400s, 403,
 *   429, `self_decision`, `account_not_in_good_standing` and `policy_unreadable` (a grant fails
 *   closed, nothing written).
 * - `state_changed`: the account's state is not what the page showed (`not_requested`,
 *   `already_active`, `not_active`, `stale_state`); read the account again.
 * - `not_found`: `account_not_found`; the row is stale.
 * - `signed_out`: a 401.
 * - `unknown_outcome`: the decision may or may not have been written. A lost connection, a
 *   timeout, an unreadable answer, any 5xx (a 500 can follow a committed decision), the proxy's
 *   own words and any other answer that did not come from the route. Read the account again;
 *   never repeat the POST.
 */
export type DecisionFailure =
  | "refused"
  | "state_changed"
  | "not_found"
  | "signed_out"
  | "unknown_outcome";

const STATE_CHANGED: ReadonlySet<string> = new Set<ComputeAccessAdminErrorCode>([
  "not_requested",
  "already_active",
  "not_active",
  "stale_state",
]);

export function classifyDecisionFailure(err: unknown): DecisionFailure {
  if (!(err instanceof ComputeAdminApiError)) return "unknown_outcome";
  if (err.code) {
    if (STATE_CHANGED.has(err.code)) return "state_changed";
    if (err.code === "account_not_found") return "not_found";
    if (err.code === "policy_unreadable") return "refused";
    // `internal` and any other word on a 5xx: the route spoke, but the batch may have committed.
    return err.status >= 500 ? "unknown_outcome" : "refused";
  }
  if (err.status === 401) return "signed_out";
  if (err.status === 403 || err.status === 429) return "refused";
  return "unknown_outcome";
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/** The badge's fallback is logged at most this often per isolate, as the other badges do. */
const BADGE_WARN_EVERY_MS = 60_000;
let badgeWarnedAt = Number.NEGATIVE_INFINITY;

/** For tests: forget when the badge last warned. */
export function resetComputeBadgeWarning(): void {
  badgeWarnedAt = Number.NEGATIVE_INFINITY;
}

export interface ComputeRequestsCount {
  /** The rows the first page served: exact unless `capped`. */
  readonly count: number;
  /** True when a next page exists, so the real number is larger. */
  readonly capped: boolean;
}

/**
 * Requests awaiting a decision, for the Compute tab badge. There is no count route
 * (nemar-cli#2085), so this is the length of the first page of the `requested` listing, capped
 * at the page maximum with `capped` set when more exist. This is the one number the page derives,
 * and it is the row count of a served list, not a computed quantity. Never throws: the shared
 * admin shell renders on every page and must not break on a compute hiccup, and a null is logged
 * so a broken route is not indistinguishable from an empty queue.
 */
export async function fetchComputeRequestsCount(
  init: Init = {},
): Promise<ComputeRequestsCount | null> {
  try {
    const page = await computeFetch(
      "GET",
      `/access${computeAccessQuery({ state: "requested", limit: COMPUTE_ACCESS_PAGE_MAX })}`,
      init,
      parseAccessPage,
      { timeoutMs: BADGE_TIMEOUT_MS },
    );
    return { count: page.accounts.length, capped: page.next_after !== null };
  } catch (err) {
    const now = Date.now();
    if (now - badgeWarnedAt >= BADGE_WARN_EVERY_MS) {
      badgeWarnedAt = now;
      console.warn(
        "[compute-admin-api] compute badge degraded to null:",
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }
}

/** Narrowing helpers for the views. */
export function isListedState(value: string): value is ComputeAccessListedState {
  return (COMPUTE_ACCESS_LISTED_STATES as readonly string[]).includes(value);
}
export function isJobFlag(value: string): value is ComputeJobFlag {
  return (COMPUTE_JOB_FLAGS as readonly string[]).includes(value);
}
export function isHolderKind(value: string): value is ComputePoolHolderKind {
  return (COMPUTE_POOL_HOLDER_KINDS as readonly string[]).includes(value);
}
