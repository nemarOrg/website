/**
 * Edge cache for the public catalog reads in `api.ts`: fresh for minutes,
 * served instantly while it refreshes for hours, and kept for up to three days
 * so an API outage does not take the catalog down with it (ADR 0025).
 *
 * Why this exists: every page this site renders on the server calls
 * api.nemar.org from inside a Cloudflare Worker, so all visitors reach the API
 * from one small pool of Cloudflare egress IPs. The API rate-limits anonymous
 * traffic per IP (`backend/src/middleware/rateLimit.ts` in nemar-cli), which
 * makes that pool one shared budget. When it runs dry the API answers
 * `429 Too Many Requests` and `/discover` showed "Could not load datasets"
 * for everyone, for as long as the budget stayed empty. The data is public and
 * changes slowly, and robots and people alike should find it, so the site
 * answers from a stored copy far more often than it asks.
 *
 * A stored body is in one of four states, by age:
 *
 *  - under {@link FRESH_MS}: served, no API call.
 *  - under {@link REVALIDATE_MS}: served at once, and refreshed in the
 *    background (`waitUntil`) so the next visitor gets the new data. Where
 *    there is no `waitUntil` (`astro dev`, tests) this state does not exist and
 *    the entry is refreshed inline like an older one.
 *  - under {@link RETAIN_S}: the API is asked first; when it fails the stored
 *    copy is served instead of an error, unless the failure says the data is
 *    gone (below).
 *  - older, or never stored: the API is the only source.
 *
 * A failed call is one of three kinds ({@link classify}):
 *
 *  - struggling: 429, 5xx, 408, a timeout, a network error, or a body that is
 *    not what the endpoint returns. The stored copy is served; a 429 also pauses
 *    every call for a minute, because the budget it reports is shared.
 *  - gone: a 404 or 410 for one dataset's own URL. The API answers 404 for a
 *    dataset that went private, so the stored copy is dropped, never served
 *    again, and the answer is passed on.
 *  - incident: any other 4xx (a gateway or WAF 403, a 401 from a bad deploy, a
 *    404 on a list route that always exists). It says something is broken between
 *    here and the API, not that the data is gone, and dropping copies then would
 *    remove them in the one situation they exist for. The copy is served and an
 *    error is logged every time.
 *
 * Only successful, unauthenticated GET bodies of the shape the caller expects
 * are stored. A non-JSON body, or JSON of the wrong shape, is never stored and
 * never replaces a good copy, and a stored body that fails the same checks on
 * the way out is dropped.
 *
 * Whenever a request is answered from a body that was not fresh, the request is
 * marked (`request-context.ts`) so the middleware keeps the rendered page out of
 * the edge cache for more than a minute; otherwise an hour-long page cache
 * would pin whatever stale data it was built from.
 *
 * While the API is refusing, it is left alone for {@link RETRY_AFTER_FAILURE_MS}:
 * otherwise every visitor and every crawler hit spends a request on an API that
 * is already refusing them, which prolongs the outage this module exists to
 * hide. Concurrent calls for one URL share one request, but no caller waits
 * past its own deadline for it.
 *
 * Kept free of the Workers runtime types so the logic is unit-testable: the
 * runtime is reached through the small {@link BodyStore} interface and
 * `request-context.ts`.
 */

import { currentWaitUntil, markDataStale } from "./request-context";

/** How long a stored body answers requests with no API call. */
export const FRESH_MS = 10 * 60 * 1000;

/** How long past fresh a body is still served at once while it refreshes behind. */
export const REVALIDATE_MS = 6 * 60 * 60 * 1000;

/** How long a body is kept for stale-if-error. Three days, no more. */
export const RETAIN_S = 3 * 24 * 60 * 60;

/** How long the API is left alone after it refused, while a stored copy can answer. */
export const RETRY_AFTER_FAILURE_MS = 60 * 1000;

/**
 * Distinct URLs whose failures are remembered per isolate. A crawler can mint
 * unlimited queries, so the memory is bounded and the oldest goes first; past
 * this many failing URLs a forgotten one may be retried inside its minute.
 */
export const MAX_TRACKED_KEYS = 2000;

/**
 * Part of every stored key. Bump it to orphan every stored body at once, which
 * is the only purge there is: stored bodies are not tied to a deploy, so a
 * release that starts reading a new API field, or a bad body that got stored,
 * is otherwise served until it ages out.
 */
export const CACHE_GENERATION = "1";

/** Deadline for a background refresh, which outlives the request's own timer. */
const REFRESH_TIMEOUT_MS = 15_000;

/** A request still in flight after this long is presumed lost, and is not waited for. */
export const STUCK_FLIGHT_MS = 30_000;

/** A stored time this far ahead of this isolate's clock is not believed. */
const FUTURE_SKEW_MS = 60 * 1000;

/** How long a cache write may take before it is counted as failed. */
const WRITE_DEADLINE_MS = 2000;

export interface StoredBody {
  readonly body: string;
  /** Epoch milliseconds when the body was fetched from the API. */
  readonly storedAt: number;
}

export interface BodyStore {
  get(key: string): Promise<StoredBody | undefined>;
  set(key: string, value: StoredBody): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The API answered, but not with a body we can use. `status` is its HTTP status. */
export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

/** True for the API's `429 Too Many Requests`, which the page words differently. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof UpstreamError && err.status === 429;
}

/**
 * True when the API said the thing asked for does not exist (404 or 410). A 400
 * is not "missing": a page that asks only for ids it has already validated can
 * get a 400 only from something broken between here and the API.
 */
export function isMissing(err: unknown): boolean {
  return err instanceof UpstreamError && (err.status === 404 || err.status === 410);
}

/**
 * Whether the API refused with a 429 within the last minute, so a caller that
 * is about to make an optional extra call (a consistency re-read) can leave the
 * API alone instead of adding to a budget that is already spent.
 */
export function isApiPaused(now: () => number = Date.now): boolean {
  return refusedAt !== undefined && now() - refusedAt < RETRY_AFTER_FAILURE_MS;
}

const STORED_AT_HEADER = "x-nemar-stored-at";

/** The key a URL is stored under: a private host, so it can never collide with a real URL. */
function storedRequest(key: string): Request {
  return new Request(`https://api-cache.internal/${CACHE_GENERATION}/${encodeURIComponent(key)}`);
}

/**
 * The store backed by the Workers per-data-center cache, or `undefined` where
 * there is none (unit tests, a runtime without `caches.default`). Callers treat
 * `undefined` as "no cache": every call goes to the API, as before.
 */
export function workersStore(): BodyStore | undefined {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!cache) return undefined;
  return {
    async get(key) {
      const hit = await cache.match(storedRequest(key));
      if (!hit) return undefined;
      const storedAt = Number(hit.headers.get(STORED_AT_HEADER));
      if (!Number.isFinite(storedAt) || storedAt <= 0) {
        // Writes succeed and reads always miss: the cache is off, and nothing
        // else would say so.
        if (!warnedBadStamp) {
          warnedBadStamp = true;
          console.warn(
            "[api-cache] a stored entry has no usable stamp and is treated as a miss (logged once per isolate)",
          );
        }
        return undefined;
      }
      return { body: await hit.text(), storedAt };
    },
    async set(key, value) {
      await cache.put(
        storedRequest(key),
        new Response(value.body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${RETAIN_S}`,
            [STORED_AT_HEADER]: String(value.storedAt),
          },
        }),
      );
    },
    async delete(key) {
      await cache.delete(storedRequest(key));
    },
  };
}

// --- per-isolate memory ------------------------------------------------------

/** A load in progress, shared by everyone who wants the same URL. */
interface Flight {
  readonly result: Promise<Loaded>;
  readonly startedAt: number;
}

interface Loaded {
  readonly body: string;
  readonly parsed: unknown;
  /** False when the store refused the write. */
  readonly wrote: boolean;
}

const inflight = new Map<string, Flight>();

/** When each URL last failed, for {@link RETRY_AFTER_FAILURE_MS}. Bounded: oldest out first. */
const failedAt = new Map<string, number>();

/** When the API last answered 429 to anything. The budget is shared, so it speaks for every URL. */
let refusedAt: number | undefined;

/** When the current run of failures began; cleared by a success. For escalating the log by duration. */
let outageSince: number | undefined;

/** Stale copies served under the pause since the last note about it, and when that note was made. */
let pausedServed = 0;
let lastPauseNoteAt = Number.NEGATIVE_INFINITY;

let warnedNoWaitUntil = false;
let warnedWriteFailure = false;
let warnedBadStamp = false;
let warnedFutureStamp = false;

function rememberFailure(key: string, at: number): void {
  failedAt.delete(key);
  failedAt.set(key, at);
  while (failedAt.size > MAX_TRACKED_KEYS) {
    const oldest = failedAt.keys().next().value;
    if (oldest === undefined) break;
    failedAt.delete(oldest);
  }
}

/** Whether the API should be left alone for this URL right now. */
function leaveApiAlone(key: string, at: number): boolean {
  const last = failedAt.get(key);
  if (last !== undefined && at - last < RETRY_AFTER_FAILURE_MS) return true;
  return refusedAt !== undefined && at - refusedAt < RETRY_AFTER_FAILURE_MS;
}

/** Forget everything this module remembers in the isolate. For the unit tests only. */
export function resetApiCacheStateForTests(): void {
  inflight.clear();
  failedAt.clear();
  refusedAt = undefined;
  outageSince = undefined;
  pausedServed = 0;
  lastPauseNoteAt = Number.NEGATIVE_INFINITY;
  warnedNoWaitUntil = false;
  warnedWriteFailure = false;
  warnedBadStamp = false;
  warnedFutureStamp = false;
}

// --- helpers -----------------------------------------------------------------

export interface CachedJsonOptions {
  signal: AbortSignal;
  /** Names the call in logs and error messages, e.g. "list datasets". */
  label: string;
  /** Message for a 2xx whose body is not JSON, or not accepted. Defaults to a generic one. */
  invalidBodyMessage?: string;
  /**
   * Whether a parsed body is what this endpoint returns. A body that fails is
   * treated like one that is not JSON: logged, never stored, never allowed to
   * replace a good copy, and dropped if it is found stored. Without it any JSON
   * is accepted.
   */
  accept?: (parsed: unknown) => boolean;
  /** Defaults to {@link workersStore}. Pass `null` to bypass the cache. */
  store?: BodyStore | null;
  /**
   * Skip the stored copy and ask the API, then store the answer (and drop the
   * copy if the API says the data is gone). For a read that must not act on
   * data hours old, and that should leave the cache better than it found it.
   */
  refresh?: boolean;
  /** Clock, for tests. */
  now?: () => number;
  /**
   * Runs background work after the response. Defaults to the current request's
   * (`request-context.ts`); with none, a stale entry is refreshed inline.
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The label and path, never the query: a search string is a visitor's own words. */
function where(url: string, label: string): string {
  try {
    return `${label} ${new URL(url).pathname}`;
  } catch {
    return label;
  }
}

type Verdict = "struggling" | "gone" | "incident";

/** A dataset's own URL, `/datasets/<id>`, as opposed to a list or search route. */
const DETAIL_PATH = /^\/datasets\/[A-Za-z]{2}\d{6}$/;

function isDetailUrl(url: string): boolean {
  try {
    return DETAIL_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** What a failure means for the stored copy; see the header comment. */
function classify(url: string, failure: unknown): Verdict {
  if (!(failure instanceof UpstreamError)) return "struggling";
  const status = failure.status;
  if (status === 408 || status === 429 || status >= 500) return "struggling";
  if ((status === 404 || status === 410) && isDetailUrl(url)) return "gone";
  return "incident";
}

/** A timeout or an abort, as opposed to something the API said. */
function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** What {@link readStore} hands back: a body that parsed, and when it was stored. */
interface Found {
  readonly parsed: unknown;
  readonly storedAt: number;
}

/**
 * Read and parse a stored body. Anything unusable (a store that throws, a body
 * that is not JSON or not the shape the caller expects, a stamp from the
 * future, a body past the ceiling) is a miss, never an error: a broken cache
 * must not break the page. A body that is stored but cannot be used is dropped,
 * so it is not read, and logged, on every request until something replaces it.
 */
async function readStore(
  store: BodyStore,
  key: string,
  label: string,
  now: () => number,
  accept: ((parsed: unknown) => boolean) | undefined,
): Promise<Found | undefined> {
  let stored: StoredBody | undefined;
  try {
    stored = await store.get(key);
  } catch (err) {
    console.warn(`[api-cache] ${where(key, label)}: read failed: ${errorText(err)}`);
    return undefined;
  }
  if (!stored) return undefined;
  // The cache expires entries itself, but the three-day ceiling is a promise
  // this module makes, so it is checked here too.
  const age = now() - stored.storedAt;
  if (age > RETAIN_S * 1000) return undefined;
  // A stamp ahead of our clock would read as fresh until the clock caught up.
  if (-age > FUTURE_SKEW_MS) {
    if (!warnedFutureStamp) {
      warnedFutureStamp = true;
      console.warn(
        `[api-cache] ${where(key, label)}: a stored stamp is ahead of this clock and is treated as a miss (logged once per isolate)`,
      );
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.body);
  } catch {
    console.error(`[api-cache] ${where(key, label)}: stored body is not JSON; dropping it`);
    await evict(store, key, label);
    return undefined;
  }
  if (accept && !accept(parsed)) {
    console.error(
      `[api-cache] ${where(key, label)}: stored body is not the expected shape; dropping it`,
    );
    await evict(store, key, label);
    return undefined;
  }
  return { parsed, storedAt: stored.storedAt };
}

/** Reject if `promise` takes longer than `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Write a body. Returns whether it was stored; a refusal is logged, never thrown. */
async function writeStore(
  store: BodyStore,
  key: string,
  label: string,
  value: StoredBody,
): Promise<boolean> {
  try {
    await withDeadline(store.set(key, value), WRITE_DEADLINE_MS, "cache write");
    return true;
  } catch (err) {
    // A cache that can never be written means stale-if-error does not exist,
    // which is worth one loud line per isolate rather than one per request.
    const log = warnedWriteFailure ? console.warn : console.error;
    warnedWriteFailure = true;
    log(`[api-cache] ${where(key, label)}: write failed: ${errorText(err)}`);
    return false;
  }
}

/** Drop a stored body. Returns whether it worked; a failure is logged, never thrown. */
async function evict(store: BodyStore, key: string, label: string): Promise<boolean> {
  try {
    await withDeadline(store.delete(key), WRITE_DEADLINE_MS, "cache delete");
    return true;
  } catch (err) {
    console.warn(`[api-cache] ${where(key, label)}: evict failed: ${errorText(err)}`);
    return false;
  }
}

/** GET `url`; the body text and what it parsed to, or a thrown {@link UpstreamError} / network error. */
async function fetchBody(
  url: string,
  signal: AbortSignal,
  opts: Pick<CachedJsonOptions, "label" | "accept" | "invalidBodyMessage">,
): Promise<{ body: string; parsed: unknown }> {
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) {
    // Release the connection: an unread body can hold one of the few a Worker
    // may have open until it is garbage collected.
    await res.body?.cancel().catch(() => {});
    // A 404 or 400 is an ordinary answer for the caller to handle (an unknown
    // dataset id); only a struggling service is worth a log line.
    if (res.status === 429 || res.status >= 500) {
      console.error(`[api] ${where(url, opts.label)}: ${res.status} ${res.statusText}`);
    }
    throw new UpstreamError(
      `api.nemar.org ${opts.label} failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const body = await res.text();
  const invalid = () =>
    new Error(
      opts.invalidBodyMessage ?? `api.nemar.org ${opts.label} returned an invalid response`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A 2xx with a non-JSON body (e.g. an edge timeout HTML page): never stored.
    console.error(`[api] ${where(url, opts.label)}: response body was not valid JSON`);
    throw invalid();
  }
  if (opts.accept && !opts.accept(parsed)) {
    // Valid JSON that is not what this endpoint returns (`null`, an error
    // envelope, an empty object): never stored over a good copy.
    console.error(`[api] ${where(url, opts.label)}: response did not have the expected shape`);
    throw invalid();
  }
  return { body, parsed };
}

/** Fetch, validate, and store. The one place a body enters the store. */
async function load(
  url: string,
  signal: AbortSignal,
  store: BodyStore | undefined,
  opts: CachedJsonOptions,
  now: () => number,
): Promise<Loaded> {
  const startedAt = now();
  const { body, parsed } = await fetchBody(url, signal, opts);
  // An answer says the budget is not spent, but only one that was asked after
  // the refusal can say so: a call already in flight when the 429 came back
  // tells nothing about what the API would answer now.
  if (refusedAt !== undefined && startedAt > refusedAt) refusedAt = undefined;
  if (outageSince !== undefined && startedAt > outageSince) outageSince = undefined;
  failedAt.delete(url);
  const wrote = store ? await writeStore(store, url, opts.label, { body, storedAt: now() }) : true;
  return { body, parsed, wrote };
}

/**
 * Start `run` for `url`, or join one already in flight. A flight older than
 * {@link STUCK_FLIGHT_MS} is presumed lost (a hung write, a canceled
 * `waitUntil`) and is replaced instead of waited for, so one stuck call cannot
 * wedge a URL for the life of the isolate.
 */
function fetchShared(
  url: string,
  label: string,
  now: () => number,
  run: () => Promise<Loaded>,
): { flight: Flight; creator: boolean } {
  const existing = inflight.get(url);
  if (existing) {
    if (now() - existing.startedAt <= STUCK_FLIGHT_MS) return { flight: existing, creator: false };
    console.error(`[api-cache] ${where(url, label)}: a request is stuck; starting another`);
  }
  const result: Promise<Loaded> = run().finally(() => {
    if (inflight.get(url)?.result === result) inflight.delete(url);
  });
  const flight: Flight = { result, startedAt: now() };
  inflight.set(url, flight);
  return { flight, creator: true };
}

/** Wait for `promise`, but not past `signal`: a caller's deadline is its own. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Record that a call failed: a 429 pauses the shared budget, and the URL is left alone if it has a copy to serve. */
function noteRefusal(url: string, failure: unknown, at: number, keyed: boolean): void {
  if (outageSince === undefined) outageSince = at;
  if (failure instanceof UpstreamError && failure.status === 429) refusedAt = at;
  if (keyed) rememberFailure(url, at);
}

/** Whether the API has been failing for long enough that serving stale data is an incident. */
function longOutage(at: number): boolean {
  return outageSince !== undefined && at - outageSince > REVALIDATE_MS;
}

/** Say that a stored copy was served in place of a failed call. An error once it is an incident. */
function logServedStale(
  url: string,
  label: string,
  ageMs: number,
  verdict: Verdict,
  failure: unknown,
  at: number,
): void {
  const long = ageMs > REVALIDATE_MS || longOutage(at);
  const log = verdict === "incident" || long ? console.error : console.warn;
  log(
    `[api-cache] ${where(url, label)}: serving a copy ${Math.round(ageMs / 1000)}s old after: ${errorText(failure)}${
      long ? " (the API has been failing for hours)" : ""
    }`,
  );
}

/** One line per minute per isolate about copies served under the pause, so the pause is not silent. */
function notePausedServe(url: string, label: string, ageMs: number, at: number): void {
  pausedServed++;
  if (at - lastPauseNoteAt < RETRY_AFTER_FAILURE_MS) return;
  lastPauseNoteAt = at;
  const long = ageMs > REVALIDATE_MS || longOutage(at);
  const log = long ? console.error : console.warn;
  log(
    `[api-cache] ${where(url, label)}: the API is refusing; ${pausedServed} stored ${
      pausedServed === 1 ? "copy" : "copies"
    } served without asking since the last note (this one ${Math.round(ageMs / 1000)}s old)${
      long ? "; the API has been failing for hours" : ""
    }`,
  );
  pausedServed = 0;
}

/** What a failed background refresh does. Never throws. */
async function settleRefreshFailure(
  url: string,
  store: BodyStore,
  label: string,
  failure: unknown,
  now: () => number,
): Promise<void> {
  try {
    const verdict = classify(url, failure);
    const at = now();
    if (verdict === "gone") {
      // The API says this dataset is not there (it answers 404 for one that
      // went private), so the copy is no longer true: drop it.
      console.error(
        `[api-cache] ${where(url, label)}: refresh got a definitive answer, dropping the stored copy: ${errorText(failure)}`,
      );
      if (!(await evict(store, url, label))) rememberFailure(url, at);
      return;
    }
    // The stale copy stays; the API is left alone for a minute.
    noteRefusal(url, failure, at, true);
    const log = verdict === "incident" ? console.error : console.warn;
    log(`[api-cache] ${where(url, label)}: background refresh failed: ${errorText(failure)}`);
  } catch (err) {
    console.error(
      `[api-cache] ${where(url, label)}: could not settle a failed refresh: ${errorText(err)}`,
    );
  }
}

/** Refresh `url` after the response, once per URL at a time. */
function refreshBehind(
  url: string,
  store: BodyStore,
  waitUntil: (work: Promise<unknown>) => void,
  opts: CachedJsonOptions,
  now: () => number,
): void {
  const { flight, creator } = fetchShared(url, opts.label, now, () =>
    load(url, AbortSignal.timeout(REFRESH_TIMEOUT_MS), store, opts, now),
  );
  if (!creator) return; // someone is already refreshing it
  const work = flight.result.then(
    (loaded) => {
      // A store that cannot be written never gets fresher, so do not ask the
      // API again for a minute on its account.
      if (!loaded.wrote) rememberFailure(url, now());
    },
    (failure) => settleRefreshFailure(url, store, opts.label, failure, now),
  );
  keepAlive(waitUntil, work, url, opts.label);
}

/** Hand `work` to the platform so it runs to the end after the response. Never throws. */
function keepAlive(
  waitUntil: (work: Promise<unknown>) => void,
  work: Promise<unknown>,
  url: string,
  label: string,
): void {
  try {
    waitUntil(work);
  } catch (err) {
    // This is an optimization: failing to supervise the work must not fail the
    // page the visitor can already have.
    console.error(
      `[api-cache] ${where(url, label)}: waitUntil threw; the work runs unsupervised: ${errorText(err)}`,
    );
  }
}

/**
 * GET `url` as JSON, through the cache. Throws what the uncached call would
 * have thrown, except when a stored copy exists and the failure does not say
 * the data is gone, in which case the copy is returned.
 */
export async function cachedJson<T>(url: string, opts: CachedJsonOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const store = opts.store === undefined ? workersStore() : (opts.store ?? undefined);
  const found =
    store && !opts.refresh ? await readStore(store, url, opts.label, now, opts.accept) : undefined;

  if (store && found) {
    const age = Math.max(0, now() - found.storedAt);
    if (age < FRESH_MS) return found.parsed as T;

    // The API refused us a moment ago: do not ask again yet.
    if (leaveApiAlone(url, now())) {
      markDataStale();
      notePausedServe(url, opts.label, age, now());
      return found.parsed as T;
    }

    if (age < REVALIDATE_MS) {
      const waitUntil = opts.waitUntil ?? currentWaitUntil();
      if (waitUntil) {
        refreshBehind(url, store, waitUntil, opts, now);
        markDataStale();
        return found.parsed as T;
      }
      if (!warnedNoWaitUntil) {
        // Expected under `astro dev` and in tests. In production it means the
        // request context was lost and every refresh now costs a visitor
        // latency, with nothing else to say so.
        warnedNoWaitUntil = true;
        console.warn(
          `[api-cache] ${where(url, opts.label)}: no waitUntil; refreshing inline (logged once per isolate)`,
        );
      }
    }
  } else if (store && refusedAt !== undefined && now() - refusedAt < RETRY_AFTER_FAILURE_MS) {
    // Nothing to fall back on, and the shared budget is spent: asking would
    // only spend another request to be told so. Answer as the API would.
    throw new UpstreamError(
      `api.nemar.org ${opts.label} failed: 429 Too Many Requests (not retried for a minute)`,
      429,
    );
  }

  // The caller's own deadline is gone (the page's shared timer ran out while
  // earlier calls were slow). The API was never asked, so nothing is recorded
  // against it.
  if (opts.signal.aborted) {
    if (found) {
      markDataStale();
      return found.parsed as T;
    }
    throw opts.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }

  try {
    for (let attempt = 0; ; attempt++) {
      const { flight, creator } = fetchShared(url, opts.label, now, () =>
        load(url, opts.signal, store, opts, now),
      );
      if (creator) {
        // Keep the call alive if this request is canceled (a client that
        // disconnects), so joiners and the cache still get its answer.
        const waitUntil = opts.waitUntil ?? currentWaitUntil();
        if (waitUntil) {
          keepAlive(
            waitUntil,
            flight.result.then(
              () => undefined,
              () => undefined,
            ),
            url,
            opts.label,
          );
        }
      }
      try {
        // A caller that joined waits for the creator's call, but never past
        // its own deadline.
        const loaded = creator ? await flight.result : await raceAbort(flight.result, opts.signal);
        // The caller that started the call gets the object it parsed; a caller
        // that joined gets a copy of its own, so nobody shares a mutable value.
        return (creator ? loaded.parsed : JSON.parse(loaded.body)) as T;
      } catch (err) {
        // The creator's own deadline ended the call, not the API: a joiner whose
        // deadline is still open asks for itself, once.
        if (!creator && attempt === 0 && isAbortLike(err) && !opts.signal.aborted) continue;
        throw err;
      }
    }
  } catch (failure) {
    const verdict = classify(url, failure);
    const at = now();
    if (verdict === "gone") {
      // Do not serve what the API says is not there; and drop the stored copy
      // even when this read did not consult it, so nobody else is served it.
      if (store && !(await evict(store, url, opts.label))) rememberFailure(url, at);
      throw failure;
    }
    noteRefusal(url, failure, at, found !== undefined);
    if (store && found) {
      markDataStale();
      logServedStale(url, opts.label, at - found.storedAt, verdict, failure, at);
      return found.parsed as T;
    }
    throw failure;
  }
}
