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
 *  - under {@link RETAIN_S}: the API is asked first; when it fails (429, 5xx,
 *    timeout, network error) the stored copy is served instead of an error.
 *  - older, or never stored: the API is the only source.
 *
 * Only successful, unauthenticated GET bodies are stored. Anything else (404,
 * 400, a body that is not JSON) is never cached and surfaces unchanged.
 *
 * While the API is failing, a stale entry is served without calling it again
 * for {@link RETRY_AFTER_FAILURE_MS}: otherwise every visitor would spend a
 * request on an API that is already refusing them, which prolongs the outage
 * this module exists to hide.
 *
 * Kept free of the Workers runtime types so the logic is unit-testable: the
 * runtime is reached through the small {@link BodyStore} interface and
 * `request-context.ts`.
 */

import { currentWaitUntil } from "./request-context";

/** How long a stored body answers requests with no API call. */
export const FRESH_MS = 10 * 60 * 1000;

/** How long past fresh a body is still served at once while it refreshes behind. */
export const REVALIDATE_MS = 6 * 60 * 60 * 1000;

/** How long a body is kept for stale-if-error. Three days, no more. */
export const RETAIN_S = 3 * 24 * 60 * 60;

/** After a failed call, how long a stale entry is served without asking again. */
export const RETRY_AFTER_FAILURE_MS = 60 * 1000;

/** Deadline for a background refresh, which outlives the request's own timer. */
const REFRESH_TIMEOUT_MS = 15_000;

/** Distinct keys remembered per isolate. A crawler can mint unlimited queries. */
const MAX_TRACKED_KEYS = 500;

export interface StoredBody {
  readonly body: string;
  /** Epoch milliseconds when the body was fetched from the API. */
  readonly storedAt: number;
}

export interface BodyStore {
  get(key: string): Promise<StoredBody | undefined>;
  set(key: string, value: StoredBody): Promise<void>;
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
      const hit = await cache.match(new Request(key));
      if (!hit) return undefined;
      const storedAt = Number(hit.headers.get(STORED_AT_HEADER));
      if (!Number.isFinite(storedAt) || storedAt <= 0) return undefined;
      return { body: await hit.text(), storedAt };
    },
    async set(key, value) {
      await cache.put(
        new Request(key),
        new Response(value.body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${RETAIN_S}`,
            [STORED_AT_HEADER]: String(value.storedAt),
          },
        }),
      );
    },
  };
}

// --- per-isolate memory: refreshes in flight, and recent failures -----------

/** One background refresh per key at a time, so a burst of visitors starts one call. */
const refreshing = new Map<string, Promise<void>>();

/** When each key last failed, for {@link RETRY_AFTER_FAILURE_MS}. Bounded: oldest out first. */
const failedAt = new Map<string, number>();

function rememberFailure(key: string, at: number): void {
  failedAt.delete(key);
  failedAt.set(key, at);
  while (failedAt.size > MAX_TRACKED_KEYS) {
    const oldest = failedAt.keys().next().value;
    if (oldest === undefined) break;
    failedAt.delete(oldest);
  }
}

function failedRecently(key: string, at: number): boolean {
  const last = failedAt.get(key);
  return last !== undefined && at - last < RETRY_AFTER_FAILURE_MS;
}

/** Forget in-flight refreshes and failures. For the unit tests only. */
export function resetApiCacheStateForTests(): void {
  refreshing.clear();
  failedAt.clear();
}

// --- the fetch -------------------------------------------------------------

export interface CachedJsonOptions {
  signal: AbortSignal;
  /** Names the call in logs and error messages, e.g. "list datasets". */
  label: string;
  /** Message for a 2xx whose body is not JSON. Defaults to a generic one. */
  invalidBodyMessage?: string;
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

async function readStore(store: BodyStore, key: string): Promise<StoredBody | undefined> {
  try {
    return await store.get(key);
  } catch (err) {
    // A broken cache must never break the page: behave as a miss.
    console.warn(`[api-cache] read failed: ${errorText(err)}`);
    return undefined;
  }
}

async function writeStore(store: BodyStore, key: string, value: StoredBody): Promise<void> {
  try {
    await store.set(key, value);
  } catch (err) {
    console.warn(`[api-cache] write failed: ${errorText(err)}`);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GET `url`; the parsed body and its text, or a thrown {@link UpstreamError} / network error. */
async function fetchJson<T>(
  url: string,
  signal: AbortSignal,
  label: string,
  invalidBodyMessage: string | undefined,
): Promise<{ body: string; parsed: T }> {
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) {
    // A 404 or 400 is an ordinary answer for the caller to handle (an unknown
    // dataset id); only a struggling service is worth a log line.
    if (res.status === 429 || res.status >= 500) {
      console.error(`[api] ${label}: ${res.status} ${res.statusText}`);
    }
    throw new UpstreamError(
      `api.nemar.org ${label} failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const body = await res.text();
  try {
    return { body, parsed: JSON.parse(body) as T };
  } catch {
    // A 2xx with a non-JSON body (e.g. an edge timeout HTML page): never stored.
    console.error(`[api] ${label}: response body was not valid JSON`);
    throw new Error(invalidBodyMessage ?? `api.nemar.org ${label} returned an invalid response`);
  }
}

/** Whether a failure says the service is struggling, as opposed to the request being wrong. */
function isTransient(failure: unknown): boolean {
  return !(failure instanceof UpstreamError) || failure.status === 429 || failure.status >= 500;
}

/** Refresh `url` after the response, once per key per isolate. */
function refreshBehind(
  url: string,
  store: BodyStore,
  waitUntil: (work: Promise<unknown>) => void,
  label: string,
  now: () => number,
): void {
  if (refreshing.has(url)) return;
  const work = (async () => {
    try {
      const { body } = await fetchJson<unknown>(
        url,
        AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        label,
        undefined,
      );
      await writeStore(store, url, { body, storedAt: now() });
    } catch (err) {
      // The stale copy stays; do not retry for a minute.
      rememberFailure(url, now());
      console.warn(`[api-cache] ${label}: background refresh failed: ${errorText(err)}`);
    } finally {
      refreshing.delete(url);
    }
  })();
  refreshing.set(url, work);
  waitUntil(work);
}

/**
 * GET `url` as JSON, through the cache. Throws what the uncached call would
 * have thrown, except when a stored copy exists, in which case it is returned.
 */
export async function cachedJson<T>(url: string, opts: CachedJsonOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const store = opts.store === undefined ? workersStore() : opts.store;
  const found = store ? await readStore(store, url) : undefined;
  // The cache expires entries itself, but the three-day ceiling is a promise
  // this module makes, so it is checked here too.
  const stored = found && now() - found.storedAt <= RETAIN_S * 1000 ? found : undefined;

  if (store && stored) {
    const age = now() - stored.storedAt;
    if (age < FRESH_MS) return JSON.parse(stored.body) as T;

    // The API refused us a moment ago: do not ask again yet.
    if (failedRecently(url, now())) return JSON.parse(stored.body) as T;

    if (age < REVALIDATE_MS) {
      const waitUntil = opts.waitUntil ?? currentWaitUntil();
      if (waitUntil) {
        refreshBehind(url, store, waitUntil, opts.label, now);
        return JSON.parse(stored.body) as T;
      }
    }
  }

  try {
    const { body, parsed } = await fetchJson<T>(
      url,
      opts.signal,
      opts.label,
      opts.invalidBodyMessage,
    );
    if (store) await writeStore(store, url, { body, storedAt: now() });
    return parsed;
  } catch (failure) {
    // A 4xx other than 429 means this request is wrong, not that the service
    // is struggling: a stale 200 would hide a real answer (a dataset that was
    // removed, an id that is malformed).
    if (stored && isTransient(failure)) {
      rememberFailure(url, now());
      const ageS = Math.round((now() - stored.storedAt) / 1000);
      console.warn(
        `[api-cache] ${opts.label}: serving a copy ${ageS}s old after: ${errorText(failure)}`,
      );
      return JSON.parse(stored.body) as T;
    }
    throw failure;
  }
}
