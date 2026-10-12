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
 *  - under {@link RETAIN_S}: the API is asked first; when it fails with
 *    something that says the service is struggling (429, 5xx, 408, timeout,
 *    network error, or a body that is not what the endpoint returns) the stored
 *    copy is served instead of an error.
 *  - older, or never stored: the API is the only source.
 *
 * Only successful, unauthenticated GET bodies of the shape the caller expects
 * are stored. A non-JSON body, or JSON of the wrong shape, is never stored and
 * never replaces a good copy. An answer that says the request itself is wrong
 * (404, 400, 403 and the other 4xx except 408 and 429) is never masked by a
 * stored copy, on either path: the inline path throws it, and a background
 * refresh that receives one evicts the copy, so a withdrawn dataset is gone
 * after the next refresh instead of lingering for hours.
 *
 * Whenever a request is answered from a body that was not fresh, the request is
 * marked (`request-context.ts`) so the middleware keeps the rendered page out of
 * the edge cache for more than a minute; otherwise an hour-long page cache
 * would pin whatever stale data it was built from.
 *
 * While the API is refusing, it is left alone: a 429 (the shared per-IP budget,
 * so it predicts the next one for any URL) pauses all calls for
 * {@link RETRY_AFTER_FAILURE_MS}, and any other failure pauses calls for that
 * URL. Otherwise every visitor and every crawler hit spends a request on an API
 * that is already refusing them, which prolongs the outage this module exists
 * to hide. Concurrent calls for one URL share one request.
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
const STUCK_FLIGHT_MS = 2 * REFRESH_TIMEOUT_MS;

/** A stored time this far ahead of this isolate's clock is not believed. */
const FUTURE_SKEW_MS = 60 * 1000;

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
      if (!Number.isFinite(storedAt) || storedAt <= 0) return undefined;
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

let warnedNoWaitUntil = false;
let warnedWriteFailure = false;

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
  warnedNoWaitUntil = false;
  warnedWriteFailure = false;
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
   * replace a good copy. Without it any JSON is accepted.
   */
  accept?: (parsed: unknown) => boolean;
  /** Defaults to {@link workersStore}. Pass `null` to bypass the cache. */
  store?: BodyStore | null;
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

/** Whether a failure says the service is struggling, as opposed to the request being wrong. */
function isTransient(failure: unknown): boolean {
  if (!(failure instanceof UpstreamError)) return true;
  return failure.status === 408 || failure.status === 429 || failure.status >= 500;
}

/** What {@link readStore} hands back: a body that parsed, and when it was stored. */
interface Found {
  readonly parsed: unknown;
  readonly storedAt: number;
}

/**
 * Read and parse a stored body. Anything unusable (a store that throws, a body
 * that is not JSON, a stamp from the future, a body past the ceiling) is a miss,
 * never an error: a broken cache must not break the page.
 */
async function readStore(
  store: BodyStore,
  key: string,
  label: string,
  now: () => number,
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
  if (now() - stored.storedAt > RETAIN_S * 1000) return undefined;
  // A stamp ahead of our clock would read as fresh until the clock caught up.
  if (stored.storedAt - now() > FUTURE_SKEW_MS) return undefined;
  try {
    return { parsed: JSON.parse(stored.body), storedAt: stored.storedAt };
  } catch {
    console.error(`[api-cache] ${where(key, label)}: stored body is not JSON; treating as a miss`);
    return undefined;
  }
}

/** Write a body. Returns whether it was stored; a refusal is logged, never thrown. */
async function writeStore(
  store: BodyStore,
  key: string,
  label: string,
  value: StoredBody,
): Promise<boolean> {
  try {
    await store.set(key, value);
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

async function evict(store: BodyStore, key: string, label: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (err) {
    console.warn(`[api-cache] ${where(key, label)}: evict failed: ${errorText(err)}`);
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
  const { body, parsed } = await fetchBody(url, signal, opts);
  // An answer says the budget is not spent, and the URL is not failing.
  refusedAt = undefined;
  failedAt.delete(url);
  const wrote = store ? await writeStore(store, url, opts.label, { body, storedAt: now() }) : true;
  return { body, parsed, wrote };
}

/**
 * Start `run` for `url`, or join one already in flight. A flight older than
 * {@link STUCK_FLIGHT_MS} is presumed lost (a hung write, a cancelled
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
    if (now() - existing.startedAt < STUCK_FLIGHT_MS) return { flight: existing, creator: false };
    console.error(`[api-cache] ${where(url, label)}: a request is stuck; starting another`);
  }
  const result: Promise<Loaded> = run().finally(() => {
    if (inflight.get(url)?.result === result) inflight.delete(url);
  });
  const flight: Flight = { result, startedAt: now() };
  inflight.set(url, flight);
  return { flight, creator: true };
}

/** Record that the API refused: pause the shared budget on a 429, and this URL on anything. */
function noteRefusal(url: string, failure: unknown, at: number, keyed: boolean): void {
  if (failure instanceof UpstreamError && failure.status === 429) refusedAt = at;
  if (keyed) rememberFailure(url, at);
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
    if (isTransient(failure)) {
      // The stale copy stays; the API is left alone for a minute.
      noteRefusal(url, failure, now(), true);
      console.warn(
        `[api-cache] ${where(url, label)}: background refresh failed: ${errorText(failure)}`,
      );
      return;
    }
    // The API says this request is wrong (the dataset is gone, the id is
    // malformed, access changed): the copy is no longer true, so drop it.
    console.error(
      `[api-cache] ${where(url, label)}: refresh got a definitive answer, dropping the stored copy: ${errorText(failure)}`,
    );
    await evict(store, url, label);
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
  try {
    waitUntil(work);
  } catch (err) {
    // The refresh is an optimization: failing to supervise it must not fail the
    // page the visitor can already have.
    console.error(
      `[api-cache] ${where(url, opts.label)}: waitUntil threw; the refresh runs unsupervised: ${errorText(err)}`,
    );
  }
}

/**
 * GET `url` as JSON, through the cache. Throws what the uncached call would
 * have thrown, except when a stored copy exists and the failure says the
 * service is struggling, in which case the copy is returned.
 */
export async function cachedJson<T>(url: string, opts: CachedJsonOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const store = opts.store === undefined ? workersStore() : (opts.store ?? undefined);
  const found = store ? await readStore(store, url, opts.label, now) : undefined;

  if (store && found) {
    const age = Math.max(0, now() - found.storedAt);
    if (age < FRESH_MS) return found.parsed as T;

    // The API refused us a moment ago: do not ask again yet.
    if (leaveApiAlone(url, now())) {
      markDataStale();
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

  try {
    const { flight, creator } = fetchShared(url, opts.label, now, () =>
      load(url, opts.signal, store, opts, now),
    );
    const loaded = await flight.result;
    // The caller that started the request gets the object it parsed; a caller
    // that joined gets a copy of its own, so nobody shares a mutable value.
    return (creator ? loaded.parsed : JSON.parse(loaded.body)) as T;
  } catch (failure) {
    if (isTransient(failure)) {
      noteRefusal(url, failure, now(), found !== undefined);
      if (store && found) {
        // A 4xx other than 408 and 429 is not here: the request is wrong, and a
        // stale 200 would hide a real answer (a dataset that was removed).
        markDataStale();
        const ageS = Math.round((now() - found.storedAt) / 1000);
        // Past the revalidate window means the API has been failing for hours,
        // which is an incident and not a blip.
        const log = ageS * 1000 > REVALIDATE_MS ? console.error : console.warn;
        log(
          `[api-cache] ${where(url, opts.label)}: serving a copy ${ageS}s old after: ${errorText(failure)}`,
        );
        return found.parsed as T;
      }
    } else if (store && found) {
      await evict(store, url, opts.label);
    }
    throw failure;
  }
}
